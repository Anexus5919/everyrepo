import { Command } from "commander";
import { openContext, openLlm } from "../context.ts";

export function llmCommand(): Command {
  return new Command("llm")
    .description("Send one prompt through the models configured for a task")
    .argument("<task>", "task name from the llm config, for example summary")
    .argument("<prompt...>", "prompt text")
    .option("--max-tokens <n>", "answer length limit", "400")
    .action(async (task: string, words: string[], options: { maxTokens: string }) => {
      const context = await openContext();
      const llm = openLlm(context);
      try {
        const started = Date.now();
        const result = await llm.router.complete(
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
        llm.close();
        context.close();
      }
    });
}
