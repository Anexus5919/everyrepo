import { existsSync } from "node:fs";
import { Command } from "commander";
import { dbCommand } from "./commands/db.ts";
import { evalCommand } from "./commands/eval.ts";
import { indexCommand } from "./commands/index-repo.ts";
import { reportCommand } from "./commands/report.ts";
import { reposCommand } from "./commands/repos.ts";
import { searchCommand } from "./commands/search.ts";

// Secrets such as provider tokens live in a gitignored .env next to the local config
if (existsSync(".env")) process.loadEnvFile(".env");

const program = new Command()
  .name("everyrepo")
  .description("Index and explain open-source repositories")
  .version("0.0.0");

program.addCommand(reposCommand());
program.addCommand(dbCommand());
program.addCommand(indexCommand());
program.addCommand(reportCommand());
program.addCommand(searchCommand());
program.addCommand(evalCommand());

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
