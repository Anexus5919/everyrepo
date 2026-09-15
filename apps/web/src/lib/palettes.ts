/// <reference lib="dom" />

export type PaletteGroup = "colour" | "reading";

export interface PaletteInfo {
  id: string;
  name: string;
  group: PaletteGroup;
  description: string;
  // Background, main accent and second accent, for the dark and the light theme
  dark: [string, string, string];
  light: [string, string, string];
}

export const DEFAULT_PALETTE = "tide";

export const PALETTE_GROUPS: Array<{ id: PaletteGroup; label: string }> = [
  { id: "colour", label: "Colour" },
  { id: "reading", label: "Easier reading" },
];

export const PALETTES: PaletteInfo[] = [
  {
    id: "tide",
    name: "Tide",
    group: "colour",
    description: "Sea green and sky blue",
    dark: ["#0a0f12", "#2fd3a6", "#4cb6ff"],
    light: ["#eef4f3", "#0a7a5f", "#1f7fd1"],
  },
  {
    id: "ember",
    name: "Ember",
    group: "colour",
    description: "Warm orange on soft black",
    dark: ["#0d0c0a", "#ee7a43", "#f6b16c"],
    light: ["#f5f1e8", "#a6481f", "#b8662a"],
  },
  {
    id: "cobalt",
    name: "Cobalt",
    group: "colour",
    description: "Electric blue and cyan on graphite",
    dark: ["#0b0c10", "#5b8cff", "#56d4f5"],
    light: ["#f1f3f8", "#2f5fe0", "#0d8fb3"],
  },
  {
    id: "moss",
    name: "Moss",
    group: "colour",
    description: "Moss green and brass",
    dark: ["#0b0d0a", "#9bd46c", "#e2c46a"],
    light: ["#f1f4ec", "#3f7422", "#a57c12"],
  },
  {
    id: "amethyst",
    name: "Amethyst",
    group: "colour",
    description: "Violet and coral on ink",
    dark: ["#0d0b12", "#a98bff", "#ff9e7a"],
    light: ["#f4f1f8", "#6a45d8", "#d0603c"],
  },
  {
    id: "dusk",
    name: "Dusk",
    group: "colour",
    description: "Amber and periwinkle on night navy",
    dark: ["#0b1020", "#f2b54a", "#86a8ff"],
    light: ["#f2f4fa", "#8f5600", "#2f55cc"],
  },
  {
    id: "sepia",
    name: "Sepia",
    group: "reading",
    description: "Warm paper tones with less blue light",
    dark: ["#16120d", "#e0a95e", "#b9c47c"],
    light: ["#f3ead6", "#86501a", "#4f6a24"],
  },
  {
    id: "mist",
    name: "Mist",
    group: "reading",
    description: "Soft, low-glare greys for long sessions",
    dark: ["#15181d", "#8db4dc", "#b8a9dc"],
    light: ["#eef1f5", "#3b6a99", "#6a5aa3"],
  },
  {
    id: "contrast",
    name: "High contrast",
    group: "reading",
    description: "Black and white with bold accents",
    dark: ["#000000", "#ffd400", "#6fdcff"],
    light: ["#ffffff", "#0037b3", "#8a0050"],
  },
  {
    id: "signal",
    name: "Colour-safe",
    group: "reading",
    description: "Blue and orange that stay distinct for colour-blind readers",
    dark: ["#0c0e12", "#56b4e9", "#f0a530"],
    light: ["#f5f7fa", "#0067a6", "#a45500"],
  },
];

export const currentPalette = () => document.documentElement.dataset.palette ?? DEFAULT_PALETTE;

// A palette change fades between the old and new colours, and every palette control hears about it
export function applyPalette(id: string): void {
  if (!PALETTES.some((palette) => palette.id === id)) return;
  const root = document.documentElement;
  const update = () => {
    // Always named, since Ember's colours are the base tokens and Tide is the default
    root.dataset.palette = id;
    try {
      localStorage.setItem("palette", id);
    } catch {
      // The choice then lasts only for this page view
    }
    window.dispatchEvent(new CustomEvent("palettechange", { detail: id }));
  };
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (
    currentPalette() === id ||
    reduced ||
    !("startViewTransition" in document) ||
    root.classList.contains("theme-sweep")
  ) {
    update();
    return;
  }
  // The colours change even if the browser never gets to run the fade
  let applied = false;
  const once = () => {
    if (applied) return;
    applied = true;
    update();
  };
  root.classList.add("palette-fade");
  document.startViewTransition(once).finished.finally(() => root.classList.remove("palette-fade"));
  window.setTimeout(() => {
    once();
    root.classList.remove("palette-fade");
  }, 1_000);
}
