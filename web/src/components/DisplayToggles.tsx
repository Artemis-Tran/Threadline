import SmoothScrollToggle from "./SmoothScrollToggle";
import ThemeToggle from "./ThemeToggle";
import styles from "./DisplayToggles.module.css";

export default function DisplayToggles() {
  return (
    <div className={styles.group}>
      <SmoothScrollToggle />
      <ThemeToggle />
    </div>
  );
}
