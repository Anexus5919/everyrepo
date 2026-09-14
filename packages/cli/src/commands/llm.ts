import { LlmCache, llmCachePath, recordUsage, requestsLastDay } from "@everyrepo/db";
import { createRouterFromConfig } from "@everyrepo/llm";
import { Command } from "commander";
import { openContext } from "../context.ts";

export function llmCommand(): Command {
  return new Command("llm")
    .description("Send one prompt through the models configured for a task")
    .argument("<task>", "task name from the llm config, for example summary")
    .argument("<prompt...>", "prompt text")
    .option("--max-tokens <n>", "answer length limit", "400")
    .action(async (task: string, words: string[], options: { maxTokens: string }) => {
      const context = await openContext();
      const llm = context.config.llm;
      if (!llm) throw new Error("Add an llm section to the local config first");
      const cache = new LlmCache(llmCachePath(context.config.dataDir));
      try {
        const router = createRouterFromConfig(llm, {
          cache,
          ledger: {
            requestsLastDay: (provider, model) => requestsLastDay(context.appDb, provider, model),
            record: (result) =>
              recordUsage(context.appDb, {
                provider: result.provider,
                model: result.model,
                tokens: result.inputTokens + result.outputTokens,
                neurons: 0,
              }),
          },
        });
        const started = Date.now();
        const result = await router.complete(
          task,
          {
            messages: [{ role: "user", content: words.join(" ") }],
            maxTokens: Number(options.maxTokens),
          },
          { promptVersion: "cli" },
        );
        console.log(result.text.trim());
        console.log(
          `\n${result.provider} ${result.model}, ${result.inputTokens} in, ${result.outputTokens} out, ${Date.now() - started} ms${result.cached ? ", cached" : ""}`,
        );
      } finally {
        cache.close();
        context.close();
      }
    });
}
