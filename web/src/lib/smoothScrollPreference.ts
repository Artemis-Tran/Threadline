// Smooth scrolling is a global display preference, so it lives in
// localStorage like the theme rather than in per-book IndexedDB prefs.
export const SMOOTH_SCROLL_STORAGE_KEY = "threadline-smooth-scroll";

type Listener = (enabled: boolean) => void;

const listeners = new Set<Listener>();
let currentEnabled: boolean | null = null;

export function parseSmoothScrollPreference(raw: string | null): boolean {
  return raw !== "off";
}

export function getSmoothScrollEnabled(): boolean {
  if (currentEnabled === null) {
    try {
      currentEnabled = parseSmoothScrollPreference(localStorage.getItem(SMOOTH_SCROLL_STORAGE_KEY));
    } catch {
      currentEnabled = true;
    }
  }
  return currentEnabled;
}

export function setSmoothScrollEnabled(enabled: boolean): void {
  currentEnabled = enabled;
  try {
    localStorage.setItem(SMOOTH_SCROLL_STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable — the in-memory choice still lasts this session.
  }
  for (const listener of listeners) listener(enabled);
}

export function subscribeSmoothScroll(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
