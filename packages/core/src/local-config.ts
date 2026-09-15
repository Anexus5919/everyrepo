import { readFile } from "node:fs/promises";
import { z } from "zod";
import { SIZE_TIERS } from "./vocabulary.ts";

const localRepoSchema = z.object({
  path: z.string().min(1),
  remote: z.string().min(1).default("origin"),
  defaultBranch: z.string().min(1).optional(),
});

// A local server exposing /v1/embeddings; command starts it when nothing answers at baseUrl
const localEmbeddingsSchema = z.object({
  provider: z.literal("local"),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  dimensions: z.number().int().positive(),
  batchSize: z.number().int().positive().default(16),
  command: z.array(z.string()).optional(),
});

// Cloudflare Workers AI; credentials come from CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN
const workersAiEmbeddingsSchema = z.object({
  provider: z.literal("workers-ai"),
  model: z.string().min(1).default("@cf/qwen/qwen3-embedding-0.6b"),
  dimensions: z.number().int().positive().default(1024),
  batchSize: z.number().int().min(1).max(32).default(32),
  concurrency: z.number().int().min(1).max(16).default(4),
  // The free allowance is 10,000 neurons over a rolling 24 hours; the rest is kept for live queries
  dailyNeuronBudget: z.number().positive().default(9_000),
});

const embeddingsSchema = z.discriminatedUnion("provider", [
  localEmbeddingsSchema,
  workersAiEmbeddingsSchema,
]);

// Chat models by name with the limits of their free tier, and the ordered models each task may use
const llmModelSchema = z.object({
  provider: z.enum(["gemini", "groq", "workers-ai"]),
  model: z.string().min(1),
  requestsPerMinute: z.number().int().positive(),
  tokensPerMinute: z.number().int().positive(),
  requestsPerDay: z.number().int().positive(),
});

const llmSchema = z
  .object({
    models: z.record(z.string(), llmModelSchema),
    tasks: z.record(z.string(), z.array(z.string()).min(1)),
  })
  .superRefine((llm, context) => {
    for (const [task, ids] of Object.entries(llm.tasks)) {
      for (const id of ids) {
        if (!llm.models[id]) {
          context.addIssue({
            code: "custom",
            message: `Task "${task}" uses unknown model "${id}"`,
          });
        }
      }
    }
  });

// Rules for repositories requested on the site; larger or later requests wait for the owner
const requestsSchema = z.object({
  autoApproveMaxTier: z.enum(SIZE_TIERS).default("M"),
  autoApprovePerDay: z.number().int().min(0).default(3),
  maxWaiting: z.number().int().positive().default(20),
});

const localConfigSchema = z.object({
  dataDir: z.string().min(1),
  localRepos: z.record(z.string(), localRepoSchema).default({}),
  embeddings: embeddingsSchema.optional(),
  llm: llmSchema.optional(),
  requests: requestsSchema.optional(),
});

export type EmbeddingsConfig = z.infer<typeof embeddingsSchema>;
export type LlmConfig = z.infer<typeof llmSchema>;
export type LocalRepo = z.infer<typeof localRepoSchema>;
export type RequestsConfig = z.infer<typeof requestsSchema>;
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
