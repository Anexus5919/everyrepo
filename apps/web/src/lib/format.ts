const LANGUAGE_NAMES: Record<string, string> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  java: "Java",
  jelly: "Jelly",
  groovy: "Groovy",
  rust: "Rust",
  python: "Python",
  go: "Go",
  css: "CSS",
  scss: "SCSS",
  html: "HTML",
  kotlin: "Kotlin",
  swift: "Swift",
};

export function languageName(language: string): string {
  return LANGUAGE_NAMES[language] ?? language.charAt(0).toUpperCase() + language.slice(1);
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function shortSha(sha: string | null): string {
  return sha ? sha.slice(0, 7) : "";
}

export function branchName(branch: string | null): string {
  return (branch ?? "").replace(/^upstream\//, "").replace(/^origin\//, "");
}

const EXTENSION_LANGUAGES: Record<string, string> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "tsx",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "jsx",
  java: "java",
  groovy: "groovy",
  rs: "rust",
  py: "python",
  go: "go",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  jelly: "xml",
  yml: "yaml",
  yaml: "yaml",
};

export function languageForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_LANGUAGES[extension] ?? "text";
}
