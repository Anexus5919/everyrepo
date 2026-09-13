import { estimateTokens, sizeTierFor, type FileKind, type SizeTier } from "@kickstart/core";
import { detectDocsSources, type DocsSource } from "./docs.ts";
import { classifyPath, generatedMatcherFromGitattributes } from "./kinds.ts";
import { detectModules, moduleForPath, type DetectedModule, type ReadText } from "./modules.ts";

export interface FileEntry {
  path: string;
  oid: string;
  bytes: number;
}

export interface DetectedFile extends FileEntry {
  language?: string;
  kind: FileKind;
  tokens: number;
  modulePath: string;
}

export interface LanguageStat {
  language: string;
  files: number;
  bytes: number;
  tokens: number;
}

export interface Detection {
  files: DetectedFile[];
  modules: DetectedModule[];
  docsSources: DocsSource[];
  languages: LanguageStat[];
  kinds: Partial<Record<FileKind, number>>;
  sourceTokens: number;
  sizeTier: SizeTier;
}

export interface DetectInput {
  entries: readonly FileEntry[];
  readText: ReadText;
  repoName: string;
}

const EXCLUDED_MODULE_KINDS = new Set<FileKind>(["vendored", "generated", "test", "example"]);

export async function detectRepository(input: DetectInput): Promise<Detection> {
  const paths = new Set(input.entries.map((entry) => entry.path));
  const readText: ReadText = (path) =>
    paths.has(path) ? input.readText(path) : Promise.resolve(undefined);
  const isGenerated = generatedMatcherFromGitattributes(await readText(".gitattributes"));

  const classified = input.entries.map((entry) => {
    const { language, kind } = classifyPath(entry.path, isGenerated);
    return {
      ...entry,
      kind,
      tokens: estimateTokens(entry.bytes),
      ...(language ? { language } : {}),
    };
  });
  const kindByPath = new Map(classified.map((file) => [file.path, file.kind]));

  const sourceCounts = new Map<string, number>();
  for (const file of classified) {
    if (file.kind === "src" && file.path.includes("/")) {
      const top = file.path.split("/")[0]!;
      sourceCounts.set(top, (sourceCounts.get(top) ?? 0) + 1);
    }
  }

  const modules = await detectModules({
    paths,
    readText,
    repoName: input.repoName,
    isExcluded: (path) => {
      const kind = kindByPath.get(path);
      return kind !== undefined && EXCLUDED_MODULE_KINDS.has(kind);
    },
    sourceFileCount: (dir) => sourceCounts.get(dir) ?? 0,
  });

  const deepestFirst = [...modules].sort((a, b) => b.path.length - a.path.length);
  const files: DetectedFile[] = classified.map((file) => ({
    ...file,
    modulePath: moduleForPath(file.path, deepestFirst).path,
  }));

  const kinds: Partial<Record<FileKind, number>> = {};
  const languages = new Map<string, LanguageStat>();
  let sourceTokens = 0;
  for (const file of files) {
    kinds[file.kind] = (kinds[file.kind] ?? 0) + 1;
    if (file.kind === "src") sourceTokens += file.tokens;
    if ((file.kind === "src" || file.kind === "types") && file.language) {
      const stat = languages.get(file.language) ?? {
        language: file.language,
        files: 0,
        bytes: 0,
        tokens: 0,
      };
      stat.files += 1;
      stat.bytes += file.bytes;
      stat.tokens += file.tokens;
      languages.set(file.language, stat);
    }
  }

  return {
    files,
    modules,
    docsSources: detectDocsSources(paths),
    languages: [...languages.values()].sort((a, b) => b.tokens - a.tokens),
    kinds,
    sourceTokens,
    sizeTier: sizeTierFor(sourceTokens),
  };
}
