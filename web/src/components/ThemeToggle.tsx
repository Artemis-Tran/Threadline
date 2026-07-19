import { useEffect, useState } from "react";
import { getResolvedTheme, nextTheme, setTheme, type ResolvedTheme } from "../lib/theme";
import styles from "./ThemeToggle.module.css";

// Icon-only two-state toggle. Shows the theme a click switches *to*: a moon
// in light mode, a sun in dark mode. Inline SVGs so no icon dependency; the
// hover title + aria-label spell out the action.
function Icon({ target }: { target: ResolvedTheme }) {
  const shared = {
    viewBox: "0 0 24 24",
    width: 16,
    height: 16,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    "aria-hidden": true,
  } as const;
  if (target === "light") {
    return (
      <svg {...shared}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>
    );
  }
  return (
    <svg {...shared}>
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" />
    </svg>
  );
}

export default function ThemeToggle() {
  const [theme, setThemeState] = useState<ResolvedTheme>(getResolvedTheme);

  // Keep the icon in sync when a user with no stored choice flips their OS
  // theme while the page is open (App's watchSystemTheme restyles the page;
  // this keeps the button's state matching it).
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setThemeState(getResolvedTheme());
    mq.addEventListener("change", onChange);
    // Reconcile immediately: an OS-theme change between the state initializer
    // and this subscription would otherwise leave the icon stale.
    onChange();
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const target = nextTheme(theme);
  const label = `Switch to ${target} theme`;
  return (
    <button
      type="button"
      className={styles.toggle}
      onClick={() => {
        setTheme(target);
        setThemeState(target);
      }}
      aria-label={label}
      title={label}
    >
      <Icon target={target} />
    </button>
  );
}
