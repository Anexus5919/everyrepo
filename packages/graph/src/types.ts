import type { FileKind, ModuleKind } from "@everyrepo/core";

export interface GraphFile {
  id: number;
  path: string;
  kind: FileKind;
  language?: string;
  modulePath: string;
  tokens: number;
  packageName?: string;
}

export interface GraphModule {
  id: number;
  name: string;
  path: string;
  kind: ModuleKind;
}

export interface GraphImport {
  id: number;
  fileId: number;
  specifier: string;
  kind: string;
  names?: string[];
}

export type Resolution = "resolved" | "external" | "unresolved";

export interface ResolvedImport {
  resolution: Resolution;
  targets: string[];
}

export const EXTERNAL: ResolvedImport = { resolution: "external", targets: [] };
export const UNRESOLVED: ResolvedImport = { resolution: "unresolved", targets: [] };

export function resolved(targets: string[]): ResolvedImport {
  return targets.length > 0 ? { resolution: "resolved", targets } : UNRESOLVED;
}

export function dirOf(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

export function joinPath(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}
