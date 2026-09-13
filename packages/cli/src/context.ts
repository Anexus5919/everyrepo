import { loadLocalConfig, type LocalConfig } from "@everyrepo/core";
import { appDbPath, openAppDb, type AppDb } from "@everyrepo/db";

export interface CliContext {
  config: LocalConfig;
  appDb: AppDb;
  close(): void;
}

export async function openContext(): Promise<CliContext> {
  const config = await loadLocalConfig();
  const appDb = openAppDb(appDbPath(config.dataDir));
  return { config, appDb, close: () => appDb.$client.close() };
}

export function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}
