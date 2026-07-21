import { useSmoothScrollEnabled } from "../hooks/useSmoothScrollPreference";
import { setSmoothScrollEnabled } from "../lib/smoothScrollPreference";
import styles from "./ThemeToggle.module.css";

export default function SmoothScrollToggle() {
  const enabled = useSmoothScrollEnabled();
  const label = `${enabled ? "Turn off" : "Turn on"} smooth scrolling`;

  return (
    <button
      type="button"
      className={`${styles.toggle} ${enabled ? "" : styles.toggleOff}`}
      onClick={() => setSmoothScrollEnabled(!enabled)}
      aria-label={label}
      aria-pressed={enabled}
      title={label}
    >
      <svg
        viewBox="0 0 24 24"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        aria-hidden
      >
        <rect x="7" y="2" width="10" height="20" rx="5" />
        <path d="M12 6v4" />
        {!enabled && <path d="M4 4l16 16" />}
      </svg>
    </button>
  );
}
