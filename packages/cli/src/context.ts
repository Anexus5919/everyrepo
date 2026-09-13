import { loadLocalConfig, type LocalConfig } from "@everyrepo/core";
import { appDbPath, neuronsUsed, openAppDb, recordUsage, type AppDb } from "@everyrepo/db";
import { openConfiguredEmbedder, type ConfiguredEmbedder } from "@everyrepo/embed";

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

// Usage is recorded per call so the daily allowance holds across separate runs
export async function openEmbedder(context: CliContext): Promise<ConfiguredEmbedder | undefined> {
  const config = context.config.embeddings;
  if (!config) return undefined;
  const model = config.model;
  return openConfiguredEmbedder(config, {
    onUsage: (usage) => recordUsage(context.appDb, { provider: config.provider, model, ...usage }),
    neuronsUsedToday: () => neuronsUsed(context.appDb, config.provider),
  });
}

export function timestamp(): string {
  return new Date().toISOString().slice(11, 19);
}
