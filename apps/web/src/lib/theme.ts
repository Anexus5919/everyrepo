/// <reference lib="dom" />

export type Theme = "light" | "dark";

let running = 0;

// The whole site blurs for a moment, then the new colours sweep in from the left and come into focus
export function changeTheme(next: Theme, apply: () => void) {
  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (root.dataset.theme === next || reduced || !("startViewTransition" in document)) {
    apply();
    return;
  }

  // The old background sits under the blurred page so its softened edges do not show the new colour
  root.style.setProperty("--sweep-from", getComputedStyle(document.body).backgroundColor);
  root.classList.add("theme-sweep");
  const id = ++running;
  document.startViewTransition(apply).finished.finally(() => {
    if (id !== running) return;
    root.classList.remove("theme-sweep");
    root.style.removeProperty("--sweep-from");
  });
}
