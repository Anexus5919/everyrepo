import { posix } from "node:path";
import type { ModuleKind } from "@everyrepo/core";
import { XMLParser } from "fast-xml-parser";
import picomatch from "picomatch";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { classifyLicenseText, isLicenseFile, normalizeLicenseField } from "./licenses.ts";

export interface DetectedModule {
  name: string;
  path: string;
  kind: ModuleKind;
  license?: string;
}

export type ReadText = (path: string) => Promise<string | undefined>;

export interface ModuleInput {
  paths: ReadonlySet<string>;
  readText: ReadText;
  repoName: string;
  // Paths whose directories should not contribute modules, such as vendored code or fixtures
  isExcluded: (path: string) => boolean;
  sourceFileCount: (topLevelDir: string) => number;
}

const xml = new XMLParser({
  ignoreAttributes: true,
  isArray: (name) => name === "module" || name === "license",
});

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function normalizeDir(dir: string): string {
  const normalized = posix
    .normalize(dir.trim())
    .replace(/^\.\/?/, "")
    .replace(/\/+$/, "");
  return normalized === "." ? "" : normalized;
}

function manifestDirs(input: ModuleInput, fileName: string): string[] {
  const dirs: string[] = [];
  for (const path of input.paths) {
    if ((path === fileName || path.endsWith(`/${fileName}`)) && !input.isExcluded(path)) {
      dirs.push(dirOf(path));
    }
  }
  return dirs;
}

async function readJson(
  input: ModuleInput,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (!input.paths.has(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse((await input.readText(path)) ?? "");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

async function readToml(
  input: ModuleInput,
  path: string,
): Promise<Record<string, unknown> | undefined> {
  if (!input.paths.has(path)) return undefined;
  try {
    return parseToml((await input.readText(path)) ?? "") as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function globMatcher(globs: string[]): (dir: string) => boolean {
  // "." refers to the repository root, which is detected separately
  const include = globs
    .filter((glob) => !glob.startsWith("!"))
    .map(normalizeDir)
    .filter(Boolean);
  const exclude = globs
    .filter((glob) => glob.startsWith("!"))
    .map((glob) => normalizeDir(glob.slice(1)))
    .filter(Boolean);
  if (include.length === 0) return () => false;
  const isIn = picomatch(include, { dot: true });
  const isOut = exclude.length > 0 ? picomatch(exclude, { dot: true }) : () => false;
  return (dir) => isIn(dir) && !isOut(dir);
}

async function npmModules(input: ModuleInput): Promise<DetectedModule[]> {
  const root = await readJson(input, "package.json");
  const globs: string[] = [];
  const workspaces = root?.["workspaces"];
  globs.push(...stringList(workspaces));
  if (workspaces && typeof workspaces === "object" && !Array.isArray(workspaces)) {
    globs.push(...stringList((workspaces as Record<string, unknown>)["packages"]));
  }
  if (input.paths.has("pnpm-workspace.yaml")) {
    try {
      const doc = parseYaml((await input.readText("pnpm-workspace.yaml")) ?? "") as Record<
        string,
        unknown
      > | null;
      globs.push(...stringList(doc?.["packages"]));
    } catch {
      // Invalid workspace files are treated as absent
    }
  }

  const modules: DetectedModule[] = [];
  if (root) modules.push(npmModule(root, "", input.repoName));
  const isMember = globMatcher(globs);
  for (const dir of manifestDirs(input, "package.json")) {
    if (!dir || !isMember(dir)) continue;
    const manifest = await readJson(input, joinPath(dir, "package.json"));
    if (manifest) modules.push(npmModule(manifest, dir, dir));
  }
  return modules;
}

function npmModule(
  manifest: Record<string, unknown>,
  path: string,
  fallbackName: string,
): DetectedModule {
  const name = typeof manifest["name"] === "string" ? manifest["name"] : fallbackName;
  const license = normalizeLicenseField(manifest["license"]);
  return { name, path, kind: "npm", ...(license ? { license } : {}) };
}

async function mavenModules(input: ModuleInput): Promise<DetectedModule[]> {
  const modules: DetectedModule[] = [];
  const queue = [""];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const dir = queue.shift()!;
    const pomPath = joinPath(dir, "pom.xml");
    if (seen.has(dir) || !input.paths.has(pomPath)) continue;
    seen.add(dir);
    let project: Record<string, unknown> | undefined;
    try {
      project = (xml.parse((await input.readText(pomPath)) ?? "") as Record<string, unknown>)[
        "project"
      ] as Record<string, unknown> | undefined;
    } catch {
      continue;
    }
    if (!project) continue;
    const artifactId =
      typeof project["artifactId"] === "string" ? project["artifactId"] : undefined;
    const licenses = (project["licenses"] as Record<string, unknown> | undefined)?.["license"];
    const license = normalizeLicenseField(Array.isArray(licenses) ? licenses[0] : undefined);
    modules.push({
      name: artifactId ?? (dir || input.repoName),
      path: dir,
      kind: "maven",
      ...(license ? { license } : {}),
    });
    const children = (project["modules"] as Record<string, unknown> | undefined)?.["module"];
    for (const child of stringList(children)) {
      queue.push(normalizeDir(posix.join(dir || ".", child)));
    }
  }
  return modules;
}

async function gradleModules(input: ModuleInput): Promise<DetectedModule[]> {
  const settingsPath = ["settings.gradle.kts", "settings.gradle"].find((path) =>
    input.paths.has(path),
  );
  if (!settingsPath) return [];
  const settings = (await input.readText(settingsPath)) ?? "";
  const rootName = /rootProject\.name\s*=\s*["']([^"']+)["']/.exec(settings)?.[1];
  const modules: DetectedModule[] = [
    { name: rootName ?? input.repoName, path: "", kind: "gradle" },
  ];
  for (const statement of settings.matchAll(/^\s*include\b(.*)$/gm)) {
    for (const quoted of (statement[1] ?? "").matchAll(/["']([^"']+)["']/g)) {
      const projectPath = (quoted[1] ?? "").replace(/^:/, "").replaceAll(":", "/");
      if (!projectPath) continue;
      const hasFiles = [...input.paths].some((path) => path.startsWith(`${projectPath}/`));
      if (hasFiles) {
        modules.push({ name: projectPath.split("/").pop()!, path: projectPath, kind: "gradle" });
      }
    }
  }
  return modules;
}

async function cargoModules(input: ModuleInput): Promise<DetectedModule[]> {
  const root = await readToml(input, "Cargo.toml");
  if (!root) return [];
  const modules: DetectedModule[] = [];
  const rootPackage = root["package"] as Record<string, unknown> | undefined;
  if (rootPackage) modules.push(cargoModule(rootPackage, "", input.repoName));
  const workspace = root["workspace"] as Record<string, unknown> | undefined;
  const isMember = globMatcher([
    ...stringList(workspace?.["members"]),
    ...stringList(workspace?.["exclude"]).map((glob) => `!${glob}`),
  ]);
  for (const dir of manifestDirs(input, "Cargo.toml")) {
    if (!dir || !isMember(dir)) continue;
    const manifest = await readToml(input, joinPath(dir, "Cargo.toml"));
    const pkg = manifest?.["package"] as Record<string, unknown> | undefined;
    if (pkg) modules.push(cargoModule(pkg, dir, dir));
  }
  return modules;
}

function cargoModule(
  pkg: Record<string, unknown>,
  path: string,
  fallbackName: string,
): DetectedModule {
  const name = typeof pkg["name"] === "string" ? pkg["name"] : fallbackName;
  const license = normalizeLicenseField(pkg["license"]);
  return { name, path, kind: "cargo", ...(license ? { license } : {}) };
}

async function goModules(input: ModuleInput): Promise<DetectedModule[]> {
  const modules: DetectedModule[] = [];
  for (const dir of manifestDirs(input, "go.mod")) {
    const content = (await input.readText(joinPath(dir, "go.mod"))) ?? "";
    const name = /^module\s+(\S+)/m.exec(content)?.[1] ?? (dir || input.repoName);
    modules.push({ name, path: dir, kind: "go" });
  }
  return modules;
}

async function pythonModules(input: ModuleInput): Promise<DetectedModule[]> {
  const modules: DetectedModule[] = [];
  for (const dir of manifestDirs(input, "pyproject.toml")) {
    const doc = await readToml(input, joinPath(dir, "pyproject.toml"));
    const project = doc?.["project"] as Record<string, unknown> | undefined;
    const poetry = (doc?.["tool"] as Record<string, unknown> | undefined)?.["poetry"] as
      Record<string, unknown> | undefined;
    const rawName = project?.["name"] ?? poetry?.["name"];
    if (typeof rawName !== "string") continue;
    const license = normalizeLicenseField(project?.["license"] ?? poetry?.["license"]);
    modules.push({ name: rawName, path: dir, kind: "python", ...(license ? { license } : {}) });
  }
  return modules;
}

async function attachLicenses(input: ModuleInput, modules: DetectedModule[]): Promise<void> {
  const licenseFiles = new Map<string, string>();
  for (const path of input.paths) {
    const fileName = path.slice(path.lastIndexOf("/") + 1);
    if (isLicenseFile(fileName) && !licenseFiles.has(dirOf(path))) {
      licenseFiles.set(dirOf(path), path);
    }
  }
  const byDepth = [...modules].sort((a, b) => a.path.length - b.path.length);
  for (const module of byDepth) {
    if (module.license) continue;
    const file = licenseFiles.get(module.path);
    if (file) {
      module.license = classifyLicenseText((await input.readText(file)) ?? "");
      continue;
    }
    const parent = byDepth.find(
      (candidate) =>
        candidate !== module &&
        candidate.license &&
        (candidate.path === "" || module.path.startsWith(`${candidate.path}/`)),
    );
    if (parent?.license) module.license = parent.license;
  }
}

export async function detectModules(input: ModuleInput): Promise<DetectedModule[]> {
  const detected = [
    ...(await npmModules(input)),
    ...(await mavenModules(input)),
    ...(await gradleModules(input)),
    ...(await cargoModules(input)),
    ...(await goModules(input)),
    ...(await pythonModules(input)),
  ];

  // One module per directory; the first ecosystem found wins
  const byPath = new Map<string, DetectedModule>();
  for (const module of detected) {
    if (!byPath.has(module.path)) byPath.set(module.path, module);
  }

  if (![...byPath.keys()].some((path) => path !== "")) {
    const topLevel = new Set(
      [...input.paths].filter((path) => path.includes("/")).map((path) => path.split("/")[0]!),
    );
    for (const dir of topLevel) {
      if (input.sourceFileCount(dir) >= 20) {
        byPath.set(dir, { name: dir, path: dir, kind: "directory" });
      }
    }
  }
  if (!byPath.has("")) {
    byPath.set("", { name: input.repoName, path: "", kind: "repository" });
  }

  const modules = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  await attachLicenses(input, modules);
  return modules;
}

// Returns the deepest module containing the file
export function moduleForPath(
  path: string,
  modulesDeepestFirst: readonly DetectedModule[],
): DetectedModule {
  const found = modulesDeepestFirst.find(
    (module) => module.path === "" || path.startsWith(`${module.path}/`),
  );
  if (!found) throw new Error("A root module is required");
  return found;
}
