import type { FileKind } from "@kickstart/core";
import picomatch from "picomatch";
import { CODE_LANGUAGES, DATA_LANGUAGES, detectLanguage, extensionOf } from "./languages.ts";

const VENDORED_DIRS = new Set([
  "node_modules",
  "vendor",
  "vendors",
  "third_party",
  "third-party",
  "thirdparty",
  "bower_components",
]);
const TEST_DIRS = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "__mocks__",
  "cypress",
]);
const EXAMPLE_DIRS = new Set([
  "examples",
  "example",
  "demo",
  "demos",
  "samples",
  "sample",
  "sandbox",
]);
const LOCALE_DIRS = new Set(["locales", "locale", "i18n", "l10n", "translations"]);
const DOCS_ROOTS = new Set(["docs", "doc", "documentation", "website"]);
const LOCKFILES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "cargo.lock",
  "go.sum",
  "poetry.lock",
  "composer.lock",
  "gemfile.lock",
  "uv.lock",
]);
const ASSET_EXTENSIONS = new Set(
  (
    ".png .jpg .jpeg .gif .svg .ico .webp .avif .bmp .tif .tiff .mp3 .mp4 .wav .ogg .webm .mov " +
    ".woff .woff2 .ttf .otf .eot .pdf .zip .gz .tgz .jar .war .class .so .dll .exe .wasm .psd .sketch .fig .lottie"
  ).split(" "),
);
const CONFIG_FILENAMES = new Set([
  "package.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "cargo.toml",
  "go.mod",
  "go.work",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "dockerfile",
  "makefile",
  "jenkinsfile",
]);

export interface ClassifiedPath {
  language?: string;
  kind: FileKind;
}

export type GeneratedMatcher = (path: string) => boolean;

// Builds a matcher from .gitattributes lines marked linguist-generated or linguist-vendored
export function generatedMatcherFromGitattributes(content: string | undefined): GeneratedMatcher {
  if (!content) return () => false;
  const patterns: string[] = [];
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [pattern, ...attributes] = line.split(/\s+/);
    if (!pattern) continue;
    const marked = attributes.some((attribute) =>
      /^linguist-(generated|vendored)(=true)?$/.test(attribute),
    );
    if (!marked) continue;
    const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern;
    patterns.push(pattern.includes("/") ? anchored : `**/${anchored}`);
  }
  if (patterns.length === 0) return () => false;
  const isMatch = picomatch(patterns, { dot: true });
  return (path) => isMatch(path);
}

export function classifyPath(
  path: string,
  isGenerated: GeneratedMatcher = () => false,
): ClassifiedPath {
  const segments = path.split("/");
  const fileName = segments[segments.length - 1] ?? path;
  const lower = fileName.toLowerCase();
  const dirs = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  const extension = extensionOf(fileName);
  const detected = detectLanguage(path);
  const language = detected ? { language: detected } : {};
  const result = (kind: FileKind): ClassifiedPath => ({ ...language, kind });

  if (dirs.some((dir) => VENDORED_DIRS.has(dir)) || /\.min\.(js|css)$/.test(lower)) {
    return result("vendored");
  }
  if (
    isGenerated(path) ||
    LOCKFILES.has(lower) ||
    dirs.includes("__generated__") ||
    dirs.includes("__snapshots__") ||
    dirs.includes("dist") ||
    /\.generated\.|\.pb\.go$|_pb2\.py$|\.snap$/.test(lower)
  ) {
    return result("generated");
  }
  if (ASSET_EXTENSIONS.has(extension)) return result("asset");
  if (
    dirs.some((dir) => TEST_DIRS.has(dir)) ||
    /\.(test|spec)\.[^.]+$/.test(lower) ||
    /_test\.(go|py)$/.test(lower) ||
    /^test_.*\.py$/.test(lower) ||
    /^[A-Z]\w*(Test|Tests|IT)\.(java|kt|scala|groovy)$/.test(fileName)
  ) {
    return result("test");
  }
  if (dirs.some((dir) => EXAMPLE_DIRS.has(dir))) return result("example");
  if (dirs.some((dir) => LOCALE_DIRS.has(dir)) || extension === ".po" || extension === ".pot") {
    return result("locale");
  }
  if (
    (dirs[0] !== undefined && DOCS_ROOTS.has(dirs[0])) ||
    detected === "markdown" ||
    detected === "mdx" ||
    detected === "rst"
  ) {
    return result("docs");
  }
  if (/\.d\.[mc]?ts$/.test(lower)) return result("types");
  if (
    lower.startsWith(".") ||
    dirs.some((dir) => dir.startsWith(".")) ||
    CONFIG_FILENAMES.has(lower) ||
    /\.config\.[cm]?[jt]s$/.test(lower) ||
    /^tsconfig.*\.json$/.test(lower) ||
    (detected !== undefined && DATA_LANGUAGES.has(detected))
  ) {
    return result("config");
  }
  if (detected !== undefined && CODE_LANGUAGES.has(detected)) return result("src");
  return result("other");
}
