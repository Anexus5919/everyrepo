type Child = Node | string | null | undefined | false;

// Builds elements from data without writing HTML, so text from GitHub can never become markup
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, string | number | boolean | undefined> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (name === "class") element.className = String(value);
    else element.setAttribute(name, value === true ? "" : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child);
  }
  return element;
}

const SVG = "http://www.w3.org/2000/svg";

// Small inline icons drawn with the current text colour
export function icon(
  name: "star" | "files" | "check" | "arrow" | "clock" | "alert" | "github",
): SVGSVGElement {
  const paths: Record<typeof name, string> = {
    star: "M8 1.8l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.6l-3.8 2 .7-4.3-3.1-3 4.3-.6z",
    files: "M4 1.8h5l3 3v9.4H4zM9 1.8v3h3",
    check: "M3.2 8.4l3 3 6.6-6.8",
    arrow: "M3 8h10M9 4l4 4-4 4",
    clock: "M8 2.2a5.8 5.8 0 1 0 0 11.6A5.8 5.8 0 0 0 8 2.2zM8 4.8V8l2.2 1.4",
    alert: "M8 2.2l6 10.6H2zM8 6.4v3M8 11.2v.1",
    github:
      "M8 1.5a6.5 6.5 0 0 0-2.06 12.67c.33.06.44-.14.44-.31v-1.1c-1.8.39-2.18-.87-2.18-.87-.3-.75-.72-.95-.72-.95-.59-.4.04-.39.04-.39.65.05 1 .67 1 .67.58 1 1.52.71 1.89.54.06-.42.23-.71.41-.87-1.44-.16-2.95-.72-2.95-3.2 0-.71.25-1.29.67-1.74-.07-.17-.29-.83.06-1.72 0 0 .55-.18 1.79.66a6.2 6.2 0 0 1 3.26 0c1.24-.84 1.79-.66 1.79-.66.35.89.13 1.55.06 1.72.42.45.67 1.03.67 1.74 0 2.49-1.51 3.04-2.96 3.2.23.2.44.6.44 1.21v1.79c0 .17.12.38.45.31A6.5 6.5 0 0 0 8 1.5z",
  };
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("icon", `icon-${name}`);
  const path = document.createElementNS(SVG, "path");
  path.setAttribute("d", paths[name]);
  svg.append(path);
  return svg;
}
