import {
  dirOf,
  EXTERNAL,
  joinPath,
  resolved,
  UNRESOLVED,
  type GraphModule,
  type ResolvedImport,
} from "../types.ts";

export function createRustResolver(paths: ReadonlySet<string>, modules: readonly GraphModule[]) {
  const crates = modules
    .filter((module) => module.kind === "cargo")
    .sort((a, b) => b.path.length - a.path.length);
  const byCrateName = new Map(crates.map((crate) => [crate.name.replaceAll("-", "_"), crate]));

  const crateOf = (path: string) =>
    crates.find((crate) => crate.path === "" || path.startsWith(`${crate.path}/`));

  // Module path of a file inside its crate, for example src/a/b.rs -> [a, b]
  function modulePath(crate: GraphModule, path: string): string[] {
    const srcRoot = joinPath(crate.path, "src");
    const relative = path.startsWith(`${srcRoot}/`) ? path.slice(srcRoot.length + 1) : path;
    const segments = relative.replace(/\.rs$/, "").split("/");
    const last = segments[segments.length - 1];
    if (last === "mod" || last === "lib" || last === "main") segments.pop();
    return segments;
  }

  function fileFor(crate: GraphModule, segments: string[]): string | undefined {
    const srcRoot = joinPath(crate.path, "src");
    // Trailing segments may name items such as types or functions, so shorter paths are tried too
    for (let length = segments.length; length >= 0; length -= 1) {
      const base = joinPath(srcRoot, ...segments.slice(0, length));
      if (length === 0) {
        for (const root of ["lib.rs", "main.rs"]) {
          if (paths.has(joinPath(srcRoot, root))) return joinPath(srcRoot, root);
        }
      } else if (paths.has(`${base}.rs`)) {
        return `${base}.rs`;
      } else if (paths.has(`${base}/mod.rs`)) {
        return `${base}/mod.rs`;
      }
    }
    return undefined;
  }

  return function resolveRust(fromPath: string, specifier: string, kind: string): ResolvedImport {
    if (kind === "mod") {
      const fileName = fromPath.slice(fromPath.lastIndexOf("/") + 1);
      const isDirOwner = ["mod.rs", "lib.rs", "main.rs"].includes(fileName);
      const dir = isDirOwner ? dirOf(fromPath) : fromPath.replace(/\.rs$/, "");
      for (const candidate of [
        joinPath(dir, `${specifier}.rs`),
        joinPath(dir, specifier, "mod.rs"),
      ]) {
        if (paths.has(candidate)) return resolved([candidate]);
      }
      return UNRESOLVED;
    }

    const segments = specifier.split("::").filter(Boolean);
    const head = segments[0];
    const currentCrate = crateOf(fromPath);
    let crate: GraphModule | undefined;
    let base: string[] = [];
    let rest = segments.slice(1);

    if (head === "crate") {
      crate = currentCrate;
    } else if (head === "self" || head === "super") {
      crate = currentCrate;
      if (crate) {
        base = modulePath(crate, fromPath);
        rest = segments;
        while (rest[0] === "super") {
          base = base.slice(0, -1);
          rest = rest.slice(1);
        }
        if (rest[0] === "self") rest = rest.slice(1);
      }
    } else if (head && byCrateName.has(head)) {
      crate = byCrateName.get(head);
    } else {
      return EXTERNAL;
    }
    if (!crate) return UNRESOLVED;
    const found = fileFor(crate, [...base, ...rest]);
    return found && found !== fromPath ? resolved([found]) : UNRESOLVED;
  };
}
