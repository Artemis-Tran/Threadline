// Theme preference for the wiki. Persistence is deliberately localStorage,
// not IndexedDB: the preference must be readable synchronously before first
// paint (see the inline bootstrap in index.html) or a user who overrode the
// system theme would see a wrong-theme flash on every load.
//
// The toggle is two-state (light ↔ dark). "system" is not a selectable state —
// it only describes a user who has never clicked the toggle: they follow the
// OS theme (including live changes) until their first click stores an
// explicit choice, which then sticks permanently.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const STORAGE_KEY = "threadline-theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

// --- Pure core (unit-tested; no DOM or storage access) ---

export function parsePreference(raw: string | null): ThemePreference {
  return raw === "light" || raw === "dark" ? raw : "system";
}

export function nextTheme(theme: ResolvedTheme): ResolvedTheme {
  return theme === "dark" ? "light" : "dark";
}

export function resolveTheme(pref: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return pref === "system" ? (systemPrefersDark ? "dark" : "light") : pref;
}

// --- DOM/storage glue ---

// The active preference is held in module memory, seeded lazily from
// localStorage. Memory is the source of truth after that: if storage is
// unavailable (strict privacy modes), a chosen theme still sticks for the
// session instead of silently reverting to "system" on the next read.
let currentPref: ThemePreference | null = null;

export function getStoredPreference(): ThemePreference {
  if (currentPref === null) {
    try {
      currentPref = parsePreference(localStorage.getItem(STORAGE_KEY));
    } catch {
      currentPref = "system"; // localStorage can throw in strict privacy modes
    }
  }
  return currentPref;
}

export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(getStoredPreference(), window.matchMedia(DARK_QUERY).matches);
}

function applyPreference(pref: ThemePreference): void {
  const systemPrefersDark = window.matchMedia(DARK_QUERY).matches;
  document.documentElement.dataset.theme = resolveTheme(pref, systemPrefersDark);
}

// Stamps the theme before persisting, so a storage failure still themes the
// page for this visit — the choice just won't survive a reload.
export function setTheme(theme: ResolvedTheme): void {
  currentPref = theme;
  applyPreference(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // storage unavailable — in-memory theme already applied above
  }
}

// Follow live OS theme changes while no explicit choice is stored. Returns an
// unsubscribe function — the caller must clean up (React StrictMode
// double-invokes effects in dev, which would otherwise stack listeners).
export function watchSystemTheme(): () => void {
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => {
    if (getStoredPreference() === "system") applyPreference("system");
  };
  mq.addEventListener("change", onChange);
  // Reconcile immediately: an OS-theme change between the pre-paint bootstrap
  // and this subscription would otherwise be missed until the next change.
  onChange();
  return () => mq.removeEventListener("change", onChange);
}
