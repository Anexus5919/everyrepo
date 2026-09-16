import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  ModelUnavailableError,
  type ChatModel,
  type ChatRequest,
  type ChatResult,
} from "./types.ts";

export interface ResponseCache {
  get(key: string): ChatResult | undefined;
  set(key: string, result: ChatResult): void;
}

export interface CompleteOptions {
  // Bumping a prompt version makes earlier cached answers for it stale
  promptVersion: string;
  // Asks the model again instead of using a saved answer, which then replaces the saved one
  fresh?: boolean;
}

export function parseJson<T>(
  text: string,
  schema: z.ZodType<T>,
): { ok: true; value: T } | { ok: false; error: string } {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let data: unknown;
  try {
    data = JSON.parse(trimmed);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; "),
  };
}

// Tries each model configured for a task in order, moving on when one is out of allowance
export class LlmRouter {
  constructor(
    private readonly tasks: Record<string, readonly ChatModel[]>,
    private readonly cache?: ResponseCache,
  ) {}

  hasTask(task: string): boolean {
    return (this.tasks[task]?.length ?? 0) > 0;
  }

  models(task: string): readonly ChatModel[] {
    const models = this.tasks[task];
    if (!models || models.length === 0) throw new Error(`No models configured for task "${task}"`);
    return models;
  }

  async complete(
    task: string,
    request: ChatRequest,
    options: CompleteOptions,
  ): Promise<ChatResult> {
    const failures: string[] = [];
    for (const model of this.models(task)) {
      const key = createHash("sha256")
        .update(JSON.stringify([model.provider, model.model, options.promptVersion, request]))
        .digest("hex");
      const hit = options.fresh ? undefined : this.cache?.get(key);
      if (hit) return { ...hit, cached: true };
      try {
        const result = await model.complete(request);
        this.cache?.set(key, result);
        return result;
      } catch (error) {
        if (!(error instanceof ModelUnavailableError)) throw error;
        failures.push(error.message);
      }
    }
    throw new ModelUnavailableError(
      `No model available for "${task}": ${failures.join("; ")}`,
      task,
    );
  }

  // Validates a JSON answer and asks once more with the validation error when it does not fit
  async completeJson<T>(
    task: string,
    request: ChatRequest,
    schema: z.ZodType<T>,
    options: CompleteOptions,
  ): Promise<{ value: T; result: ChatResult }> {
    const first = await this.complete(task, { ...request, json: true }, options);
    const parsed = parseJson(first.text, schema);
    if (parsed.ok) return { value: parsed.value, result: first };
    const repair: ChatRequest = {
      ...request,
      json: true,
      messages: [
        ...request.messages,
        { role: "assistant", content: first.text },
        {
          role: "user",
          content: `That answer did not match the required JSON shape: ${parsed.error}. Reply again with only the corrected JSON.`,
        },
      ],
    };
    const second = await this.complete(task, repair, options);
    const retried = parseJson(second.text, schema);
    if (retried.ok) return { value: retried.value, result: second };
    throw new Error(`Answer for "${task}" does not match the JSON schema: ${retried.error}`);
  }
}
