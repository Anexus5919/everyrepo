export type DocsSourceKind =
  "docusaurus" | "mkdocs" | "sphinx" | "vitepress" | "starlight" | "markdown";

export interface DocsSource {
  kind: DocsSourceKind;
  path: string;
}

const MARKDOWN_ROOTS = new Set(["docs", "doc", "documentation", "website"]);

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function detectDocsSources(paths: Iterable<string>): DocsSource[] {
  const found = new Map<string, DocsSource>();
  const markdownCounts = new Map<string, number>();
  const add = (kind: DocsSourceKind, path: string) => {
    if (!found.has(path)) found.set(path, { kind, path });
  };

  for (const path of paths) {
    if (path.split("/").includes("node_modules")) continue;
    if (/(^|\/)docusaurus\.config\.[cm]?[jt]s$/.test(path)) add("docusaurus", dirOf(path));
    else if (/(^|\/)mkdocs\.ya?ml$/.test(path)) add("mkdocs", dirOf(path));
    else if (/(^|\/)(docs?|documentation)(\/source)?\/conf\.py$/.test(path))
      add("sphinx", dirOf(path));
    else if (/(^|\/)\.vitepress\/config\.[cm]?[jt]s$/.test(path))
      add("vitepress", dirOf(dirOf(path)));

    const starlight = /^(.*?)\/?src\/content\/docs\//.exec(path);
    if (starlight) add("starlight", starlight[1] ?? "");

    const top = path.split("/")[0]!.toLowerCase();
    if (path.includes("/") && MARKDOWN_ROOTS.has(top) && /\.mdx?$/i.test(path)) {
      const root = path.split("/")[0]!;
      markdownCounts.set(root, (markdownCounts.get(root) ?? 0) + 1);
    }
  }

  for (const [root, count] of markdownCounts) {
    const covered = [...found.values()].some(
      (source) =>
        source.path === root || (source.path !== "" && root.startsWith(`${source.path}/`)),
    );
    if (count >= 5 && !covered) add("markdown", root);
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path));
}
