import { dirOf, EXTERNAL, joinPath, resolved, UNRESOLVED, type ResolvedImport } from "../types.ts";

export interface PythonResolverInput {
  paths: ReadonlySet<string>;
  // Directories that act as import roots, such as the repository root, src folders and package dirs
  roots: string[];
}

export function createPythonResolver(input: PythonResolverInput) {
  const { paths } = input;
  const roots = [...new Set(["", ...input.roots])];

  function moduleFile(dir: string, dotted: string): string | undefined {
    const base = joinPath(dir, dotted.split(".").filter(Boolean).join("/"));
    if (paths.has(`${base}.py`)) return `${base}.py`;
    if (paths.has(`${base}/__init__.py`)) return `${base}/__init__.py`;
    return undefined;
  }

  function resolveIn(dir: string, module: string, names: string[]): string[] {
    const targets: string[] = [];
    const base = module ? moduleFile(dir, module) : undefined;
    if (base) targets.push(base);
    // `from pkg import sub` may name submodules rather than symbols
    for (const name of names) {
      const sub = moduleFile(dir, module ? `${module}.${name}` : name);
      if (sub) targets.push(sub);
    }
    return targets;
  }

  return function resolvePython(
    fromPath: string,
    specifier: string,
    names: string[] = [],
  ): ResolvedImport {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 0;
    if (dots > 0) {
      let dir = dirOf(fromPath);
      for (let level = 1; level < dots; level += 1) dir = dirOf(dir);
      return resolved(resolveIn(dir, specifier.slice(dots), names));
    }
    for (const root of roots) {
      const targets = resolveIn(root, specifier, names);
      if (targets.length > 0) return resolved(targets);
    }
    const top = specifier.split(".")[0]!;
    const ownTopLevel = roots.some((root) => moduleFile(root, top));
    return ownTopLevel ? UNRESOLVED : EXTERNAL;
  };
}
