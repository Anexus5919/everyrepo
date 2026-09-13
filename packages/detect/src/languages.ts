const EXTENSIONS: Record<string, string> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".scala": "scala",
  ".groovy": "groovy",
  ".gradle": "groovy",
  ".rs": "rust",
  ".go": "go",
  ".py": "python",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".cs": "csharp",
  ".m": "objective-c",
  ".mm": "objective-cpp",
  ".dart": "dart",
  ".lua": "lua",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".vue": "vue",
  ".svelte": "svelte",
  ".astro": "astro",
  ".css": "css",
  ".scss": "scss",
  ".sass": "scss",
  ".less": "less",
  ".html": "html",
  ".htm": "html",
  ".jelly": "xml",
  ".md": "markdown",
  ".mdx": "mdx",
  ".rst": "rst",
  ".json": "json",
  ".jsonc": "json",
  ".json5": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".properties": "properties",
  ".ini": "ini",
  ".po": "gettext",
  ".pot": "gettext",
};

const FILENAMES: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  jenkinsfile: "groovy",
  gemfile: "ruby",
  rakefile: "ruby",
};

export const CODE_LANGUAGES = new Set([
  "typescript",
  "tsx",
  "javascript",
  "java",
  "kotlin",
  "scala",
  "groovy",
  "rust",
  "go",
  "python",
  "ruby",
  "php",
  "swift",
  "c",
  "cpp",
  "csharp",
  "objective-c",
  "objective-cpp",
  "dart",
  "lua",
  "shell",
  "powershell",
  "vue",
  "svelte",
  "astro",
]);

export const DATA_LANGUAGES = new Set(["json", "yaml", "toml", "xml", "properties", "ini"]);

export function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : "";
}

export function detectLanguage(path: string): string | undefined {
  const fileName = path.slice(path.lastIndexOf("/") + 1);
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".d.ts") || lower.endsWith(".d.mts") || lower.endsWith(".d.cts")) {
    return "typescript";
  }
  return EXTENSIONS[extensionOf(fileName)] ?? FILENAMES[lower];
}
