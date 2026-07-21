import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSmoothWheelController,
  dampedStep,
  dominantWheelDelta,
  normalizeWheelDelta,
  routeSmoothWheelInput,
  type FrameScheduler,
  type ScrollMetrics,
  type ScrollPort,
  type SmoothWheelInput,
} from "../src/lib/smoothWheel";

class FakeScheduler implements FrameScheduler {
  private nextId = 1;
  private timestamp = 0;
  private callbacks = new Map<number, (timestamp: number) => void>();

  request(callback: (timestamp: number) => void): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  cancel(id: number): void {
    this.callbacks.delete(id);
  }

  get pending(): number {
    return this.callbacks.size;
  }

  step(elapsedMs = 1000 / 60): void {
    this.timestamp += elapsedMs;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.timestamp);
  }

  finish(maxFrames = 240): void {
    for (let i = 0; i < maxFrames && this.pending > 0; i++) this.step();
    assert.equal(this.pending, 0, "animation did not settle");
  }
}

class FakePort implements ScrollPort {
  metrics: ScrollMetrics;
  writes: { x: number; y: number }[] = [];

  constructor(metrics: Partial<ScrollMetrics> = {}) {
    this.metrics = {
      x: 0,
      y: 0,
      maxX: 0,
      maxY: 1_000,
      viewportWidth: 800,
      viewportHeight: 600,
      lineHeight: 20,
      visible: true,
      ...metrics,
    };
  }

  read(): ScrollMetrics {
    return { ...this.metrics };
  }

  write(position: { x: number; y: number }): void {
    this.metrics.x = position.x;
    this.metrics.y = position.y;
    this.writes.push({ ...position });
  }
}

function wheel(overrides: Partial<SmoothWheelInput> = {}): SmoothWheelInput {
  return {
    deltaX: 0,
    deltaY: 0,
    deltaMode: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    cancelable: true,
    defaultPrevented: false,
    ...overrides,
  };
}

test("normalizeWheelDelta supports pixel, line, page, and Shift-horizontal input", () => {
  const metrics = new FakePort().read();
  assert.deepEqual(normalizeWheelDelta(wheel({ deltaX: 2, deltaY: -3 }), metrics), { x: 2, y: -3 });
  assert.deepEqual(normalizeWheelDelta(wheel({ deltaX: 2, deltaY: -3, deltaMode: 1 }), metrics), {
    x: 40,
    y: -60,
  });
  assert.deepEqual(normalizeWheelDelta(wheel({ deltaX: 0.5, deltaY: -0.5, deltaMode: 2 }), metrics), {
    x: 400,
    y: -300,
  });
  assert.deepEqual(normalizeWheelDelta(wheel({ deltaY: 25, shiftKey: true }), metrics), { x: 25, y: 0 });
  assert.deepEqual(normalizeWheelDelta(wheel({ deltaY: 10, deltaMode: 99 }), metrics), { x: 0, y: 0 });
});

test("dominantWheelDelta restricts the viewport to y and chooses one map axis", () => {
  assert.deepEqual(dominantWheelDelta({ x: 80, y: 20 }, "both"), { axis: "x", amount: 80 });
  assert.deepEqual(dominantWheelDelta({ x: 20, y: 80 }, "both"), { axis: "y", amount: 80 });
  assert.deepEqual(dominantWheelDelta({ x: 80, y: 0 }, "vertical"), null);
  assert.deepEqual(dominantWheelDelta({ x: 80, y: -20 }, "vertical"), { axis: "y", amount: -20 });
});

test("dampedStep is time-based rather than refresh-rate based", () => {
  const oneFrame = dampedStep(0, 100, 16, 18);
  const twoHalfFrames = dampedStep(dampedStep(0, 100, 8, 18), 100, 8, 18);
  assert.ok(Math.abs(oneFrame - twoHalfFrames) < 1e-10);
});

test("controller accumulates a vertical target and settles exactly", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 100 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  assert.equal(controller.handleWheel(wheel({ deltaY: 120 })), true);
  assert.deepEqual(controller.getTarget(), { x: 0, y: 220 });
  assert.equal(port.metrics.y, 100, "wheel handling should defer writes to RAF");
  scheduler.finish();
  assert.equal(port.metrics.y, 220);
  assert.ok(port.writes.length > 1);
});

test("controller bounds queued lead during repeated wheel bursts", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ maxY: 5_000 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler, maxLead: 200 });

  for (let i = 0; i < 10; i++) assert.equal(controller.handleWheel(wheel({ deltaY: 100 })), true);
  assert.equal(controller.getTarget().y, 200);
  scheduler.finish();
  assert.equal(port.metrics.y, 200);
});

test("controller rebases to the current position on direction reversal", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 500, maxY: 2_000 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  controller.handleWheel(wheel({ deltaY: 300 }));
  scheduler.step();
  const current = port.metrics.y;
  controller.handleWheel(wheel({ deltaY: -100 }));
  assert.ok(Math.abs(controller.getTarget().y - (current - 100)) < 1e-9);
  scheduler.finish();
  assert.ok(Math.abs(port.metrics.y - (current - 100)) < 1e-9);
});

test("both-axis controller handles horizontal and Shift-wheel input", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ maxX: 500, maxY: 500 });
  const controller = createSmoothWheelController(port, { axes: "both", scheduler });

  assert.equal(controller.handleWheel(wheel({ deltaX: 70, deltaY: 10 })), true);
  assert.equal(controller.getTarget().x, 70);
  assert.equal(controller.handleWheel(wheel({ deltaY: 30, shiftKey: true })), true);
  assert.equal(controller.getTarget().x, 100);
  scheduler.finish();
  assert.deepEqual({ x: port.metrics.x, y: port.metrics.y }, { x: 100, y: 0 });
});

test("controller releases input at a boundary so an outer scroller can handle it", () => {
  const scheduler = new FakeScheduler();
  const bottom = new FakePort({ y: 500, maxY: 500 });
  const bottomController = createSmoothWheelController(bottom, { axes: "vertical", scheduler });
  assert.equal(bottomController.handleWheel(wheel({ deltaY: 50 })), false);
  assert.equal(scheduler.pending, 0);

  const top = new FakePort({ y: 0 });
  const topController = createSmoothWheelController(top, { axes: "vertical", scheduler });
  assert.equal(topController.handleWheel(wheel({ deltaY: -50 })), false);
  assert.equal(scheduler.pending, 0);
});

test("controller releases outward input as soon as its queued target reaches a boundary", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 480, maxY: 500 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  assert.equal(controller.handleWheel(wheel({ deltaY: 100 })), true);
  assert.equal(controller.getTarget().y, 500);
  assert.equal(controller.handleWheel(wheel({ deltaY: 50 })), false);
  assert.equal(scheduler.pending, 1, "the map should finish its already-consumed tail");
  scheduler.finish();
  assert.equal(port.metrics.y, 500);
});

test("a handled nested event cancels an active viewport tail when it bubbles", () => {
  const viewportScheduler = new FakeScheduler();
  const viewport = createSmoothWheelController(new FakePort({ y: 100 }), {
    axes: "vertical",
    scheduler: viewportScheduler,
  });
  viewport.handleWheel(wheel({ deltaY: 200 }));
  assert.equal(viewportScheduler.pending, 1);

  const nestedScheduler = new FakeScheduler();
  const nested = createSmoothWheelController(new FakePort({ maxY: 500 }), {
    axes: "both",
    scheduler: nestedScheduler,
  });
  let defaultPrevented = false;
  assert.equal(
    routeSmoothWheelInput(nested, wheel({ deltaY: 80 }), () => {
      defaultPrevented = true;
    }),
    true
  );
  assert.equal(defaultPrevented, true);
  assert.equal(
    routeSmoothWheelInput(viewport, wheel({ deltaY: 80, defaultPrevented }), () => {
      throw new Error("the viewport must not claim a nested event");
    }),
    false
  );
  assert.equal(viewportScheduler.pending, 0);
});

test("controller passes through unsuitable events and cancels active easing", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 100 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  assert.equal(controller.handleWheel(wheel({ deltaY: 50, defaultPrevented: true })), false);
  assert.equal(controller.handleWheel(wheel({ deltaY: 50, cancelable: false })), false);
  assert.equal(controller.handleWheel(wheel({ deltaY: 50, ctrlKey: true })), false);
  assert.equal(controller.handleWheel(wheel({ deltaY: 50, metaKey: true })), false);
  assert.equal(scheduler.pending, 0);

  assert.equal(controller.handleWheel(wheel({ deltaY: 100 })), true);
  assert.equal(scheduler.pending, 1);
  assert.equal(controller.handleWheel(wheel({ deltaY: 100, ctrlKey: true })), false);
  assert.equal(scheduler.pending, 0);
  assert.equal(controller.getTarget().y, port.metrics.y);
});

test("controller clamps against bounds that shrink during animation", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 400, maxY: 1_000 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  controller.handleWheel(wheel({ deltaY: 500 }));
  port.metrics.maxY = 450;
  scheduler.finish();
  assert.equal(port.metrics.y, 450);
  assert.equal(controller.getTarget().y, 450);
});

test("controller cancels when an external scroll changes the rendered position", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort();
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  controller.handleWheel(wheel({ deltaY: 300 }));
  scheduler.step();
  port.metrics.y += 20;
  scheduler.step();
  assert.equal(scheduler.pending, 0);
  assert.equal(controller.getTarget().y, port.metrics.y);
});

test("hidden ports stop without writing or losing their current position", () => {
  const scheduler = new FakeScheduler();
  const port = new FakePort({ y: 100 });
  const controller = createSmoothWheelController(port, { axes: "vertical", scheduler });

  controller.handleWheel(wheel({ deltaY: 100 }));
  port.metrics.visible = false;
  scheduler.step();
  assert.equal(scheduler.pending, 0);
  assert.equal(port.metrics.y, 100);
  assert.equal(port.writes.length, 0);
});

test("destroy is idempotent and cancels pending work", () => {
  const scheduler = new FakeScheduler();
  const controller = createSmoothWheelController(new FakePort(), { axes: "vertical", scheduler });
  controller.handleWheel(wheel({ deltaY: 100 }));
  assert.equal(scheduler.pending, 1);
  controller.destroy();
  controller.destroy();
  assert.equal(scheduler.pending, 0);
  assert.equal(controller.handleWheel(wheel({ deltaY: 100 })), false);
});
