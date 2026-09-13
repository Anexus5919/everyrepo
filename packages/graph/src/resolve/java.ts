import { EXTERNAL, resolved, UNRESOLVED, type GraphFile, type ResolvedImport } from "../types.ts";

// Packages are lowercase and classes capitalized, so the package ends before the first capital
function packageOf(specifier: string, kind: string): string {
  if (kind === "wildcard") return specifier;
  const segments = specifier.split(".");
  const firstClass = segments.findIndex((segment) => /^[A-Z]/.test(segment));
  return segments.slice(0, firstClass > 0 ? firstClass : segments.length - 1).join(".");
}

// Resolves Java imports through the package declarations found while parsing
export function createJavaResolver(files: readonly GraphFile[]) {
  const byClass = new Map<string, string[]>();
  const byPackage = new Map<string, string[]>();

  for (const file of files) {
    if (file.language !== "java" || !file.packageName) continue;
    const className = file.path.slice(file.path.lastIndexOf("/") + 1).replace(/\.java$/, "");
    const fqn = `${file.packageName}.${className}`;
    byClass.set(fqn, [...(byClass.get(fqn) ?? []), file.path]);
    byPackage.set(file.packageName, [...(byPackage.get(file.packageName) ?? []), file.path]);
  }

  function findClass(name: string): string[] | undefined {
    // Nested classes such as a.b.Outer.Inner live in the file of their outer class
    const segments = name.split(".");
    for (let length = segments.length; length > 1; length -= 1) {
      const found = byClass.get(segments.slice(0, length).join("."));
      if (found) return found;
    }
    return undefined;
  }

  return function resolveJava(specifier: string, kind: string): ResolvedImport {
    let targets: string[] | undefined;
    if (kind === "wildcard") {
      targets = byPackage.get(specifier) ?? findClass(specifier);
    } else if (kind === "static") {
      targets = findClass(specifier.slice(0, specifier.lastIndexOf(".")));
    } else {
      targets = findClass(specifier);
    }
    if (targets) return resolved(targets);
    // A missing class counts as internal only when its exact package is defined in the repository
    return byPackage.has(packageOf(specifier, kind)) ? UNRESOLVED : EXTERNAL;
  };
}
