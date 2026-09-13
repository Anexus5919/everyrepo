import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const QUESTION_TYPES = ["locate", "concept", "flow", "docs"] as const;

const goldQuestionSchema = z.object({
  id: z.string().min(1),
  type: z.enum(QUESTION_TYPES),
  question: z.string().min(1),
  expected: z.array(z.string().min(1)).min(1).max(3),
  note: z.string().optional(),
});

const goldSetSchema = z.object({
  repo: z.string().min(1),
  sha: z.string().length(40),
  questions: z.array(goldQuestionSchema).min(1),
});

export type GoldQuestion = z.infer<typeof goldQuestionSchema>;
export type GoldSet = z.infer<typeof goldSetSchema>;

export const GOLD_DIR = fileURLToPath(new URL("../gold/", import.meta.url));

export async function loadGoldSets(dir = GOLD_DIR): Promise<GoldSet[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) =>
      goldSetSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8"))),
    ),
  );
}
