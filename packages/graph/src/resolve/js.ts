import { posix } from "node:path";
import { dirOf, EXTERNAL, resolved, UNRESOLVED, type ResolvedImport } from "../types.ts";

export interface PathAlias {
  // Pattern such as "@mui/x-data-grid/*" with at most one wildcard
  pattern: string;
  targets: string[];
}

export interface WorkspacePackage {
  name: string;
  path: string;
  exports?: unknown;
  entryFields?: string[];
}

export interface JsResolverInput {
  paths: ReadonlySet<string>;
  aliases: PathAlias[];
  packages: WorkspacePackage[];
}

const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".d.ts", ".js", ".jsx", ".mjs", ".cjs"];
const CONDITIONS = ["source", "types", "import", "module", "default", "require", "node", "browser"];
const BUILD_DIRS = /\/(build|dist|lib|esm|cjs|es|node|modern|out)(\/|$)/;

export function createJsResolver(input: JsResolverInput) {
  const { paths } = input;
  const packages = new Map(input.packages.map((pkg) => [pkg.name, pkg]));

  function tryFile(candidate: string): string | undefined {
    const base = posix.normalize(candidate).replace(/^\.\//, "").replace(/\/$/, "");
    if (base.startsWith("../") || base === "..") return undefined;
    if (paths.has(base)) return base;
    // TypeScript sources are often imported with the .js extension of their compiled output
    const jsExtension = /\.[mc]?jsx?$/.exec(base);
    const stem = jsExtension ? base.slice(0, -jsExtension[0].length) : base;
    for (const extension of EXTENSIONS) {
      if (paths.has(stem + extension)) return stem + extension;
    }
    for (const extension of EXTENSIONS) {
      const index = `${base}/index${extension}`;
      if (paths.has(index)) return index;
    }
    return undefined;
  }

  function fromAliases(specifier: string): string | undefined {
    for (const alias of input.aliases) {
      const star = alias.pattern.indexOf("*");
      let captured: string | undefined;
      if (star < 0) {
        if (specifier === alias.pattern) captured = "";
      } else {
        const prefix = alias.pattern.slice(0, star);
        const suffix = alias.pattern.slice(star + 1);
        if (
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix) &&
          specifier.length >= prefix.length + suffix.length
        ) {
          captured = specifier.slice(prefix.length, specifier.length - suffix.length);
        }
      }
      if (captured === undefined) continue;
      for (const target of alias.targets) {
        const found = tryFile(target.replace("*", captured));
        if (found) return found;
      }
    }
    return undefined;
  }

  function fromPackage(pkg: WorkspacePackage, subpath: string): string | undefined {
    const exportTarget = pickExport(pkg.exports, subpath ? `./${subpath}` : ".");
    const candidates: string[] = [];
    if (exportTarget) {
      candidates.push(posix.join(pkg.path, exportTarget));
      // Exports usually point at build output; the matching source lives under src
      const rooted = `/${exportTarget.replace(/^\.\//, "")}`;
      if (BUILD_DIRS.test(rooted)) {
        candidates.push(posix.join(pkg.path, rooted.replace(BUILD_DIRS, "/src/").slice(1)));
      }
    }
    if (subpath) {
      candidates.push(posix.join(pkg.path, "src", subpath), posix.join(pkg.path, subpath));
    } else {
      for (const field of pkg.entryFields ?? []) candidates.push(posix.join(pkg.path, field));
      candidates.push(
        posix.join(pkg.path, "src/index"),
        posix.join(pkg.path, "index"),
        posix.join(pkg.path, "src"),
      );
    }
    for (const candidate of candidates) {
      const found = tryFile(candidate);
      if (found) return found;
    }
    return undefined;
  }

  return function resolveJs(fromPath: string, specifier: string): ResolvedImport {
    if (
      specifier.startsWith("./") ||
      specifier.startsWith("../") ||
      specifier === "." ||
      specifier === ".."
    ) {
      const found = tryFile(posix.join(dirOf(fromPath) || ".", specifier));
      return found ? resolved([found]) : UNRESOLVED;
    }
    if (specifier.startsWith("/") || /^[a-z]+:/i.test(specifier)) return EXTERNAL;

    const aliased = fromAliases(specifier);
    if (aliased) return resolved([aliased]);

    const parts = specifier.split("/");
    const nameLength = specifier.startsWith("@") ? 2 : 1;
    const pkg = packages.get(parts.slice(0, nameLength).join("/"));
    if (!pkg) return EXTERNAL;
    const found = fromPackage(pkg, parts.slice(nameLength).join("/"));
    return found ? resolved([found]) : UNRESOLVED;
  };
}

function pickCondition(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const picked = pickCondition(item);
      if (picked) return picked;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const condition of CONDITIONS) {
      if (condition in record) {
        const picked = pickCondition(record[condition]);
        if (picked) return picked;
      }
    }
  }
  return undefined;
}

export function pickExport(exports: unknown, key: string): string | undefined {
  if (exports === undefined || exports === null) return undefined;
  if (typeof exports === "string" || Array.isArray(exports)) {
    return key === "." ? pickCondition(exports) : undefined;
  }
  if (typeof exports !== "object") return undefined;
  const record = exports as Record<string, unknown>;
  const isSubpathMap = Object.keys(record).some((entry) => entry.startsWith("."));
  if (!isSubpathMap) return key === "." ? pickCondition(record) : undefined;
  if (key in record) return pickCondition(record[key]);
  for (const [pattern, value] of Object.entries(record)) {
    const star = pattern.indexOf("*");
    if (star < 0) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    if (key.startsWith(prefix) && key.endsWith(suffix)) {
      const target = pickCondition(value);
      return target?.replace("*", key.slice(prefix.length, key.length - suffix.length));
    }
  }
  return undefined;
}
