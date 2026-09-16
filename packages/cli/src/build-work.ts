import { existsSync } from "node:fs";
import { parseRepoRef, repoDirName, type LocalConfig, type SizeTier } from "@everyrepo/core";
import {
  activeRests,
  engineDbPath,
  openEngineReadonly,
  usageBuckets,
  type AppDb,
  type RepoRow,
} from "@everyrepo/db";
import {
  CapacityLedger,
  neuronCapacityAt,
  PAGES_BY_TIER,
  PUBLISH_MS,
  taskCapacityAt,
  type BuildWork,
  type CapacityConfig,
} from "@everyrepo/requests";

type Sql = ReturnType<typeof openEngineReadonly>;

// Model and embedding limits from the local config, in the shape the estimate and retry times use
export function capacityConfig(config: LocalConfig): CapacityConfig | undefined {
  if (!config.llm) return undefined;
  const embeddings = config.embeddings;
  return {
    models: Object.entries(config.llm.models).map(([id, model]) => ({
      id,
      provider: model.provider,
      model: model.model,
      requestsPerDay: model.requestsPerDay,
      requestsPerMinute: model.requestsPerMinute,
      tokensPerMinute: model.tokensPerMinute,
    })),
    tasks: config.llm.tasks,
    embeddings:
      embeddings?.provider === "workers-ai"
        ? { provider: embeddings.provider, dailyNeuronBudget: embeddings.dailyNeuronBudget }
        : undefined,
  };
}

// Model calls a read repository still needs, counted from what its engine database already holds
function measure(sql: Sql, tier: SizeTier | null): BuildWork {
  const count = (query: string) => (sql.prepare(query).get() as { count: number }).count;
  const clusters = count("SELECT COUNT(*) AS count FROM cluster");
  const sharedModules = count(
    "SELECT COUNT(*) AS count FROM (SELECT module_id FROM cluster WHERE module_id IS NOT NULL GROUP BY module_id HAVING COUNT(*) > 1)",
  );
  const clusterSummaries = count("SELECT COUNT(*) AS count FROM summary WHERE level = 'cluster'");
  // Packages with a single cluster copy its summary without a call
  const moduleCalls = count(
    "SELECT COUNT(*) AS count FROM summary WHERE level = 'module' AND provider != 'copy'",
  );
  const repoSummary = count("SELECT COUNT(*) AS count FROM summary WHERE level = 'repo'");
  const glossary = count("SELECT COUNT(*) AS count FROM glossary_term");
  const pages = count("SELECT COUNT(*) AS count FROM wiki_page");
  const unwritten = count(
    "SELECT COUNT(*) AS count FROM wiki_page WHERE status IN ('planned', 'failed')",
  );
  return {
    readingMs: 0,
    embedTokens: 0,
    calls: {
      summary:
        Math.max(0, clusters - clusterSummaries) +
        Math.max(0, sharedModules - moduleCalls) +
        (repoSummary > 0 ? 0 : 1) +
        (glossary > 0 ? 0 : 1),
      plan: pages > 0 ? 0 : 2,
      page: pages > 0 ? unwritten : PAGES_BY_TIER[tier ?? "S"],
    },
    publishMs: PUBLISH_MS,
  };
}

const MEASURE_CACHE_MS = 30_000;

// Status pages ask often, so each engine database is measured at most every half minute
export function createWorkMeasure(dataDir: string): (repo: RepoRow) => BuildWork | undefined {
  const cache = new Map<string, { at: number; work: BuildWork | undefined }>();
  return (repo) => {
    if (!repo.lastIndexedSha) return undefined;
    const path = engineDbPath(
      dataDir,
      repoDirName(parseRepoRef(repo.fullName)),
      repo.lastIndexedSha,
    );
    const cached = cache.get(path);
    if (cached && Date.now() - cached.at < MEASURE_CACHE_MS) return cached.work;
    let work: BuildWork | undefined;
    if (existsSync(path)) {
      const sql = openEngineReadonly(path);
      try {
        work = measure(sql, repo.sizeTier);
      } catch {
        work = undefined;
      } finally {
        sql.close();
      }
    }
    cache.set(path, { at: Date.now(), work });
    return work;
  };
}

export interface AllowanceClock {
  // When a task's models can take calls again, or undefined when that is now or unknown
  modelsAt(task: string): Date | undefined;
  embeddingsAt(): Date | undefined;
}

// Paused jobs are told the moment their allowance frees up instead of guessing with doubling waits
export function createAllowanceClock(db: AppDb, config: LocalConfig): AllowanceClock {
  const capacity = capacityConfig(config);
  const later = (time: number | undefined, now: number) =>
    time !== undefined && time > now ? new Date(time) : undefined;
  return {
    modelsAt(task) {
      if (!capacity) return undefined;
      const now = Date.now();
      const ledger = new CapacityLedger(capacity, usageBuckets(db), activeRests(db));
      return later(taskCapacityAt(ledger, task, now), now);
    },
    embeddingsAt() {
      if (!capacity?.embeddings) return undefined;
      const now = Date.now();
      // A few neurons is less than one batch, so waiting for them would only fail again
      return later(neuronCapacityAt(new CapacityLedger(capacity, usageBuckets(db)), now, 50), now);
    },
  };
}
