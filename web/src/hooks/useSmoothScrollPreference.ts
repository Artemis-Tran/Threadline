import { useEffect, useState } from "react";
import { getSmoothScrollEnabled, subscribeSmoothScroll } from "../lib/smoothScrollPreference";

export function useSmoothScrollEnabled(): boolean {
  const [enabled, setEnabled] = useState(getSmoothScrollEnabled);
  useEffect(() => subscribeSmoothScroll(setEnabled), []);
  return enabled;
}
