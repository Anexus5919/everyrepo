import { Command } from "commander";
import { dbCommand } from "./commands/db.ts";
import { indexCommand } from "./commands/index-repo.ts";
import { reportCommand } from "./commands/report.ts";
import { reposCommand } from "./commands/repos.ts";

const program = new Command()
  .name("everyrepo")
  .description("Index and explain open-source repositories")
  .version("0.0.0");

program.addCommand(reposCommand());
program.addCommand(dbCommand());
program.addCommand(indexCommand());
program.addCommand(reportCommand());

try {
  await program.parseAsync();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
