/// <reference lib="dom" />

export type Theme = "light" | "dark";

let running = 0;

// The new colours spread out from the control that was used while the old ones briefly lose focus
export function changeTheme(next: Theme, apply: () => void, origin?: Element | null) {
  const root = document.documentElement;
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (root.dataset.theme === next || reduced || !("startViewTransition" in document)) {
    apply();
    return;
  }

  const box = origin?.getBoundingClientRect();
  const x = box ? box.left + box.width / 2 : window.innerWidth / 2;
  const y = box ? box.top + box.height / 2 : 0;
  const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.style.setProperty("--shift-x", `${Math.round(x)}px`);
  root.style.setProperty("--shift-y", `${Math.round(y)}px`);
  root.style.setProperty("--shift-reach", `${Math.round(reach) + 200}px`);
  root.classList.add("theme-shift");

  const id = ++running;
  document.startViewTransition(apply).finished.finally(() => {
    if (id !== running) return;
    root.classList.remove("theme-shift");
    ["--shift-x", "--shift-y", "--shift-reach"].forEach((name) => root.style.removeProperty(name));
  });
}
