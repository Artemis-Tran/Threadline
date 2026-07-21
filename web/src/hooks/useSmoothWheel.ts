import { useCallback, useEffect, useRef } from "react";
import {
  installElementSmoothWheel,
  installViewportSmoothWheel,
  type SmoothWheelAxes,
} from "../lib/smoothWheel";
import { useSmoothScrollEnabled } from "./useSmoothScrollPreference";

export function useViewportSmoothWheel(): void {
  const enabled = useSmoothScrollEnabled();
  useEffect(() => (enabled ? installViewportSmoothWheel(window) : undefined), [enabled]);
}

export function useElementSmoothWheel<T extends HTMLElement>(axes: SmoothWheelAxes): (node: T | null) => void {
  const enabled = useSmoothScrollEnabled();
  const cleanupRef = useRef<(() => void) | null>(null);
  const ref = useCallback(
    (node: T | null) => {
      cleanupRef.current?.();
      cleanupRef.current = node === null || !enabled ? null : installElementSmoothWheel(node, axes);
    },
    [axes, enabled]
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    },
    []
  );
  return ref;
}
