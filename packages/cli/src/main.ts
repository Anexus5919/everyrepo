import { Command } from "commander";
import { reposCommand } from "./commands/repos.ts";

const program = new Command()
  .name("kickstart")
  .description("Index and explain open-source repositories")
  .version("0.0.0");

program.addCommand(reposCommand());

await program.parseAsync();
