import {
  EXTERNAL,
  type GraphFile,
  type GraphImport,
  type GraphModule,
  type ResolvedImport,
} from "../types.ts";
import { createGoResolver } from "./go.ts";
import { createJavaResolver } from "./java.ts";
import { createJsResolver, type PathAlias, type WorkspacePackage } from "./js.ts";
import { createPythonResolver } from "./python.ts";
import { createRustResolver } from "./rust.ts";

export interface ResolverInput {
  files: readonly GraphFile[];
  modules: readonly GraphModule[];
  aliases: PathAlias[];
  packages: WorkspacePackage[];
  pythonRoots: string[];
}

export type ImportResolver = (file: GraphFile, ref: GraphImport) => ResolvedImport;

export function createImportResolver(input: ResolverInput): ImportResolver {
  const paths = new Set(input.files.map((file) => file.path));
  const js = createJsResolver({ paths, aliases: input.aliases, packages: input.packages });
  const java = createJavaResolver(input.files);
  const python = createPythonResolver({ paths, roots: input.pythonRoots });
  const go = createGoResolver(input.files, input.modules);
  const rust = createRustResolver(paths, input.modules);

  return (file, ref) => {
    switch (file.language) {
      case "typescript":
      case "tsx":
      case "javascript":
        return js(file.path, ref.specifier);
      case "java":
        return java(ref.specifier, ref.kind);
      case "python":
        return python(file.path, ref.specifier, ref.names);
      case "go":
        return go(ref.specifier);
      case "rust":
        return rust(file.path, ref.specifier, ref.kind);
      default:
        return EXTERNAL;
    }
  };
}

export {
  createGoResolver,
  createJavaResolver,
  createJsResolver,
  createPythonResolver,
  createRustResolver,
};
export { pickExport, type JsResolverInput, type PathAlias, type WorkspacePackage } from "./js.ts";
