import {
  dirOf,
  EXTERNAL,
  joinPath,
  resolved,
  type GraphFile,
  type GraphModule,
  type ResolvedImport,
} from "../types.ts";

// Go imports name a package directory; every non-test file in it is a target
export function createGoResolver(files: readonly GraphFile[], modules: readonly GraphModule[]) {
  const goModules = modules
    .filter((module) => module.kind === "go")
    .sort((a, b) => b.name.length - a.name.length);
  const filesByDir = new Map<string, string[]>();
  for (const file of files) {
    if (file.language !== "go" || file.path.endsWith("_test.go")) continue;
    const dir = dirOf(file.path);
    filesByDir.set(dir, [...(filesByDir.get(dir) ?? []), file.path]);
  }

  return function resolveGo(specifier: string): ResolvedImport {
    const module = goModules.find(
      (candidate) => specifier === candidate.name || specifier.startsWith(`${candidate.name}/`),
    );
    if (!module) return EXTERNAL;
    const rest = specifier.slice(module.name.length).replace(/^\//, "");
    return resolved(filesByDir.get(joinPath(module.path, rest)) ?? []);
  };
}
