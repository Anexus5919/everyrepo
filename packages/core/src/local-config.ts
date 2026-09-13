import { readFile } from "node:fs/promises";
import { z } from "zod";

const localRepoSchema = z.object({
  path: z.string().min(1),
  remote: z.string().min(1).default("origin"),
  defaultBranch: z.string().min(1).optional(),
});

const localConfigSchema = z.object({
  dataDir: z.string().min(1),
  localRepos: z.record(z.string(), localRepoSchema).default({}),
});

export type LocalRepo = z.infer<typeof localRepoSchema>;
export type LocalConfig = z.infer<typeof localConfigSchema>;

export async function loadLocalConfig(
  path = process.env["EVERYREPO_CONFIG"] ?? "everyrepo.local.json",
): Promise<LocalConfig> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Local config not found at ${path}. Copy everyrepo.local.example.json to everyrepo.local.json and edit it.`,
        { cause: error },
      );
    }
    throw error;
  }
  return localConfigSchema.parse(JSON.parse(raw));
}
