// Wheel events are intercepted only for the two explicitly registered scroll
// surfaces (the viewport and Story Map). The controller itself is DOM-free so
// its timing, bounds, and handoff behavior can be tested with fake scroll ports.
export type SmoothWheelAxes = "vertical" | "both";

export interface Point {
  x: number;
  y: number;
}

export interface ScrollMetrics extends Point {
  maxX: number;
  maxY: number;
  viewportWidth: number;
  viewportHeight: number;
  lineHeight: number;
  visible: boolean;
}

export interface ScrollPort {
  read(): ScrollMetrics;
  write(position: Point): void;
}

export interface FrameScheduler {
  request(callback: (timestamp: number) => void): number;
  cancel(id: number): void;
}

export interface SmoothWheelInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  cancelable: boolean;
  defaultPrevented: boolean;
}

export interface SmoothWheelController {
  handleWheel(input: SmoothWheelInput): boolean;
  cancel(): void;
  destroy(): void;
  getTarget(): Point;
}

export function routeSmoothWheelInput(
  controller: SmoothWheelController,
  input: SmoothWheelInput,
  preventDefault: () => void
): boolean {
  // A nested controller marks the event handled but deliberately lets it
  // bubble. The viewport sees defaultPrevented, cancels any old tail, and does
  // not move; an unhandled boundary event remains available to the viewport.
  const handled = controller.handleWheel(input);
  if (handled) preventDefault();
  return handled;
}

export interface SmoothWheelOptions {
  axes: SmoothWheelAxes;
  scheduler?: FrameScheduler;
  damping?: number;
  maxLead?: number;
}

const PIXEL_MODE = 0;
const LINE_MODE = 1;
const PAGE_MODE = 2;
const DEFAULT_LINE_HEIGHT = 16;
const DEFAULT_DAMPING = 15;
const DEFAULT_MAX_LEAD = 640;
const FRAME_FALLBACK_MS = 1000 / 60;
const MAX_FRAME_MS = 50;
const STOP_EPSILON = 0.35;
const EXTERNAL_SCROLL_EPSILON = 2;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

export function normalizeWheelDelta(input: SmoothWheelInput, metrics: ScrollMetrics): Point {
  let factorX = 1;
  let factorY = 1;
  if (input.deltaMode === LINE_MODE) {
    const lineHeight = metrics.lineHeight > 0 ? metrics.lineHeight : DEFAULT_LINE_HEIGHT;
    factorX = lineHeight;
    factorY = lineHeight;
  } else if (input.deltaMode === PAGE_MODE) {
    factorX = metrics.viewportWidth;
    factorY = metrics.viewportHeight;
  } else if (input.deltaMode !== PIXEL_MODE) {
    return { x: 0, y: 0 };
  }

  let x = finiteOr(input.deltaX, 0) * factorX;
  let y = finiteOr(input.deltaY, 0) * factorY;
  if (input.shiftKey && Math.abs(x) < STOP_EPSILON && Math.abs(y) >= STOP_EPSILON) {
    x = y;
    y = 0;
  }
  return { x, y };
}

export function dominantWheelDelta(delta: Point, axes: SmoothWheelAxes): { axis: "x" | "y"; amount: number } | null {
  if (axes === "vertical") {
    return Math.abs(delta.y) < STOP_EPSILON ? null : { axis: "y", amount: delta.y };
  }
  if (Math.abs(delta.x) < STOP_EPSILON && Math.abs(delta.y) < STOP_EPSILON) return null;
  return Math.abs(delta.x) > Math.abs(delta.y)
    ? { axis: "x", amount: delta.x }
    : { axis: "y", amount: delta.y };
}

export function dampedStep(current: number, target: number, elapsedMs: number, damping: number): number {
  const dt = clamp(finiteOr(elapsedMs, FRAME_FALLBACK_MS), 0, MAX_FRAME_MS) / 1000;
  const alpha = 1 - Math.exp(-Math.max(0, damping) * dt);
  return current + (target - current) * alpha;
}

function defaultScheduler(): FrameScheduler {
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (id) => window.cancelAnimationFrame(id),
  };
}

export function createSmoothWheelController(
  port: ScrollPort,
  options: SmoothWheelOptions
): SmoothWheelController {
  const scheduler = options.scheduler ?? defaultScheduler();
  const damping = options.damping ?? DEFAULT_DAMPING;
  const maxLead = options.maxLead ?? DEFAULT_MAX_LEAD;
  let target: Point = { x: 0, y: 0 };
  let frameId: number | null = null;
  let lastTimestamp: number | null = null;
  let lastWritten: Point | null = null;
  let destroyed = false;

  const syncTarget = (metrics = port.read()) => {
    target = { x: metrics.x, y: metrics.y };
    lastWritten = null;
    lastTimestamp = null;
  };
  syncTarget();

  const stopFrame = () => {
    if (frameId !== null) scheduler.cancel(frameId);
    frameId = null;
  };

  const cancel = () => {
    stopFrame();
    syncTarget();
  };

  const animate = (timestamp: number) => {
    frameId = null;
    if (destroyed) return;

    const metrics = port.read();
    if (!metrics.visible) {
      syncTarget(metrics);
      return;
    }
    if (
      lastWritten !== null &&
      (Math.abs(metrics.x - lastWritten.x) > EXTERNAL_SCROLL_EPSILON ||
        Math.abs(metrics.y - lastWritten.y) > EXTERNAL_SCROLL_EPSILON)
    ) {
      syncTarget(metrics);
      return;
    }

    target.x = clamp(target.x, 0, metrics.maxX);
    target.y = clamp(target.y, 0, metrics.maxY);
    const elapsed = lastTimestamp === null ? FRAME_FALLBACK_MS : timestamp - lastTimestamp;
    lastTimestamp = timestamp;
    let x = dampedStep(metrics.x, target.x, elapsed, damping);
    let y = dampedStep(metrics.y, target.y, elapsed, damping);
    if (Math.abs(target.x - x) <= STOP_EPSILON) x = target.x;
    if (Math.abs(target.y - y) <= STOP_EPSILON) y = target.y;

    const next = { x, y };
    port.write(next);
    lastWritten = next;
    if (x !== target.x || y !== target.y) {
      frameId = scheduler.request(animate);
    } else {
      lastWritten = null;
      lastTimestamp = null;
    }
  };

  const ensureFrame = () => {
    if (frameId === null) frameId = scheduler.request(animate);
  };

  const handleWheel = (input: SmoothWheelInput): boolean => {
    if (destroyed) return false;
    if (input.defaultPrevented) {
      cancel();
      return false;
    }
    if (!input.cancelable || input.ctrlKey || input.metaKey) {
      cancel();
      return false;
    }

    const metrics = port.read();
    if (!metrics.visible) {
      cancel();
      return false;
    }
    if (frameId === null) syncTarget(metrics);
    const choice = dominantWheelDelta(normalizeWheelDelta(input, metrics), options.axes);
    if (choice === null) return false;

    const { axis, amount } = choice;
    const current = metrics[axis];
    const max = axis === "x" ? metrics.maxX : metrics.maxY;
    const previousTarget = target[axis];
    const movingToBoundary = amount > 0 ? current < max - STOP_EPSILON : current > STOP_EPSILON;
    const targetHasCapacity = amount > 0 ? previousTarget < max - STOP_EPSILON : previousTarget > STOP_EPSILON;
    // Release outward input as soon as the queued target reaches an edge. This
    // avoids swallowing wheel bursts while a nested surface finishes its tail.
    if (!movingToBoundary || !targetHasCapacity) return false;

    let base = previousTarget;
    if ((previousTarget - current) * amount < 0) base = current;
    const bounded = clamp(base + amount, current - maxLead, current + maxLead);
    target[axis] = clamp(bounded, 0, max);
    if (axis === "x") target.y = clamp(target.y, 0, metrics.maxY);
    else target.x = clamp(target.x, 0, metrics.maxX);
    ensureFrame();
    return true;
  };

  return {
    handleWheel,
    cancel,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopFrame();
    },
    getTarget: () => ({ ...target }),
  };
}

function parsedLineHeight(element: Element): number {
  const value = Number.parseFloat(getComputedStyle(element).lineHeight);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_LINE_HEIGHT;
}

function windowScrollPort(win: Window): ScrollPort {
  const root = win.document.scrollingElement ?? win.document.documentElement;
  const lineElement = win.document.body ?? win.document.documentElement;
  const lineHeight = parsedLineHeight(lineElement);
  return {
    read: () => ({
      x: win.scrollX,
      y: win.scrollY,
      maxX: Math.max(0, root.scrollWidth - win.innerWidth),
      maxY: Math.max(0, root.scrollHeight - win.innerHeight),
      viewportWidth: win.innerWidth,
      viewportHeight: win.innerHeight,
      lineHeight,
      visible: win.innerWidth > 0 || win.innerHeight > 0,
    }),
    write: ({ x, y }) => win.scrollTo({ left: x, top: y, behavior: "auto" }),
  };
}

function elementScrollPort(element: HTMLElement): ScrollPort {
  const lineHeight = parsedLineHeight(element);
  return {
    read: () => ({
      x: element.scrollLeft,
      y: element.scrollTop,
      maxX: Math.max(0, element.scrollWidth - element.clientWidth),
      maxY: Math.max(0, element.scrollHeight - element.clientHeight),
      viewportWidth: element.clientWidth,
      viewportHeight: element.clientHeight,
      lineHeight,
      visible: element.clientWidth > 0 || element.clientHeight > 0,
    }),
    write: ({ x, y }) => element.scrollTo({ left: x, top: y, behavior: "auto" }),
  };
}

const SCROLL_KEYS = new Set(["ArrowDown", "ArrowLeft", "ArrowRight", "ArrowUp", "End", "Home", "PageDown", "PageUp", " "]);

function installSmoothWheel(
  eventTarget: Window | HTMLElement,
  win: Window,
  port: ScrollPort,
  axes: SmoothWheelAxes
): () => void {
  const controller = createSmoothWheelController(port, {
    axes,
    scheduler: {
      request: (callback) => win.requestAnimationFrame(callback),
      cancel: (id) => win.cancelAnimationFrame(id),
    },
  });
  const onWheel = (rawEvent: Event) => {
    const event = rawEvent as WheelEvent;
    routeSmoothWheelInput(
      controller,
      {
        deltaX: event.deltaX,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        shiftKey: event.shiftKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        cancelable: event.cancelable,
        defaultPrevented: event.defaultPrevented,
      },
      () => event.preventDefault()
    );
    // Do not stop propagation: defaultPrevented coordinates nested and
    // viewport controllers, while unhandled edge events provide scroll chain.
  };
  const cancel = () => controller.cancel();
  const onKeyDown = (event: KeyboardEvent) => {
    if (SCROLL_KEYS.has(event.key)) cancel();
  };
  const onVisibility = () => {
    if (win.document.hidden) cancel();
  };
  eventTarget.addEventListener("wheel", onWheel as EventListener, { passive: false });
  eventTarget.addEventListener("pointerdown", cancel);
  eventTarget.addEventListener("touchstart", cancel, { passive: true });
  win.addEventListener("keydown", onKeyDown);
  win.addEventListener("hashchange", cancel);
  win.addEventListener("popstate", cancel);
  win.document.addEventListener("visibilitychange", onVisibility);

  return () => {
    eventTarget.removeEventListener("wheel", onWheel as EventListener);
    eventTarget.removeEventListener("pointerdown", cancel);
    eventTarget.removeEventListener("touchstart", cancel);
    win.removeEventListener("keydown", onKeyDown);
    win.removeEventListener("hashchange", cancel);
    win.removeEventListener("popstate", cancel);
    win.document.removeEventListener("visibilitychange", onVisibility);
    controller.destroy();
  };
}

export function installViewportSmoothWheel(win: Window): () => void {
  return installSmoothWheel(win, win, windowScrollPort(win), "vertical");
}

export function installElementSmoothWheel(element: HTMLElement, axes: SmoothWheelAxes = "both"): () => void {
  const win = element.ownerDocument.defaultView;
  if (win === null) return () => {};
  return installSmoothWheel(element, win, elementScrollPort(element), axes);
}
