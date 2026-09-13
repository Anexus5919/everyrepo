import { appDbPath } from "@kickstart/db";
import { Command } from "commander";
import { openContext } from "../context.ts";

export function dbCommand(): Command {
  const db = new Command("db").description("Manage local databases");
  db.command("migrate")
    .description("Create or upgrade the application database")
    .action(async () => {
      const context = await openContext();
      context.close();
      console.log(`Application database ready at ${appDbPath(context.config.dataDir)}`);
    });
  return db;
}
