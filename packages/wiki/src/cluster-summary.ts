import { z } from "zod";
import type { ChatMessage } from "@everyrepo/llm";
import type { ClusterContext } from "./cluster-context.ts";
import { plainText } from "./text.ts";

export const CLUSTER_PROMPT_VERSION = "cluster-1";

export const clusterSummarySchema = z.object({
  title: z.string().min(2).max(80),
  purpose: z.string().min(20).max(800),
  responsibilities: z.array(z.string().min(2).max(240)).max(8),
  keyFiles: z.array(z.object({ path: z.string().min(1), role: z.string().min(2).max(240) })).max(8),
  concepts: z.array(z.string().min(1).max(80)).max(10),
});

export type ClusterSummary = z.infer<typeof clusterSummarySchema>;

const SYSTEM = [
  "You describe parts of a software repository for developers who are new to it.",
  "Use only facts that are visible in the files you are given; never guess names, files or behavior.",
  "Write plain, specific sentences. Do not use long dashes, emoji or marketing words.",
  "Reply with a single JSON object and nothing else.",
].join(" ");

export function clusterSummaryMessages(repo: string, context: ClusterContext): ChatMessage[] {
  const { cluster } = context;
  const user = [
    `Repository: ${repo}`,
    cluster.moduleName ? `Package: ${cluster.moduleName}` : "",
    `Folder hint: ${cluster.label}`,
    `This group has ${cluster.fileCount} files. Outlines of the files, most central first, then code from the most central files:`,
    "",
    context.text,
    "",
    "Describe this group of files as JSON with exactly these fields:",
    '{"title": "2 to 6 words naming what the group does",',
    ' "purpose": "2 or 3 sentences on what this part does and how it fits the repository",',
    ' "responsibilities": ["up to 6 short phrases"],',
    ' "keyFiles": [{"path": "an exact path from the outlines", "role": "one sentence"}],',
    ' "concepts": ["up to 8 terms a reader must understand, as named in the code"]}',
  ]
    .filter((line) => line !== null)
    .join("\n");
  return [
    { role: "system", content: SYSTEM },
    { role: "user", content: user },
  ];
}

// Keeps only key files that belong to the cluster and applies the writing rules to every string
export function cleanClusterSummary(
  summary: ClusterSummary,
  files: readonly string[],
): ClusterSummary {
  const known = new Set(files);
  return {
    title: plainText(summary.title),
    purpose: plainText(summary.purpose),
    responsibilities: summary.responsibilities.map(plainText),
    keyFiles: summary.keyFiles
      .filter((file) => known.has(file.path))
      .map((file) => ({ path: file.path, role: plainText(file.role) })),
    concepts: summary.concepts.map(plainText),
  };
}
