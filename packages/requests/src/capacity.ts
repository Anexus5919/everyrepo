import type { ModelRest, UsageBucket } from "@everyrepo/db";

export interface ModelAllowance {
  id: string;
  provider: string;
  model: string;
  requestsPerDay: number;
  requestsPerMinute: number;
  tokensPerMinute: number;
}

export interface CapacityConfig {
  models: readonly ModelAllowance[];
  // Model ids for each task, in the order the router tries them
  tasks: Readonly<Record<string, readonly string[]>>;
  embeddings?: { provider: string; dailyNeuronBudget: number } | undefined;
}

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

// Typical size of one call for each task; a model whose per-minute token limit is smaller cannot take it
export const TASK_CALL_TOKENS: Readonly<Record<string, number>> = {
  summary: 9_000,
  plan: 24_000,
  page: 16_000,
};

export const hourStart = (time: number) => Math.floor(time / HOUR_MS) * HOUR_MS;

// Hour buckets are written as 2026-09-15T13
const bucketTime = (hour: string) => Date.parse(`${hour}:00:00Z`);

type Series = Map<number, number>;

function add(series: Series, hour: number, amount: number): void {
  series.set(hour, (series.get(hour) ?? 0) + amount);
}

// Usage made in an hour counts until that hour plus 24 hours, the same window the model router checks
function usedAt(series: Series, time: number): number {
  let total = 0;
  for (const [hour, amount] of series) {
    if (hour <= time && time < hour + DAY_MS) total += amount;
  }
  return total;
}

function nextRelease(series: Series, time: number): number | undefined {
  let next: number | undefined;
  for (const [hour, amount] of series) {
    const release = hour + DAY_MS;
    if (amount > 0 && hour <= time && release > time && (next === undefined || release < next)) {
      next = release;
    }
  }
  return next;
}

// Rolling-day allowances for every model and for embeddings, which a simulation can spend ahead of time
export class CapacityLedger {
  private readonly requests = new Map<string, Series>();
  private readonly neurons: Series = new Map();
  // Models a provider refused, with the time each can take calls again
  private readonly rests = new Map<string, number>();

  constructor(
    readonly config: CapacityConfig,
    buckets: readonly UsageBucket[] = [],
    rests: readonly ModelRest[] = [],
  ) {
    for (const rest of rests)
      this.rests.set(`${rest.provider}/${rest.model}`, rest.until.getTime());
    for (const bucket of buckets) {
      const hour = bucketTime(bucket.hour);
      if (bucket.requests > 0)
        add(this.series(bucket.provider, bucket.model), hour, bucket.requests);
      if (bucket.neurons > 0 && bucket.provider === config.embeddings?.provider) {
        add(this.neurons, hour, bucket.neurons);
      }
    }
  }

  private series(provider: string, model: string): Series {
    const key = `${provider}/${model}`;
    let series = this.requests.get(key);
    if (!series) {
      series = new Map();
      this.requests.set(key, series);
    }
    return series;
  }

  clone(): CapacityLedger {
    const copy = new CapacityLedger(this.config);
    for (const [key, series] of this.requests) copy.requests.set(key, new Map(series));
    for (const [key, until] of this.rests) copy.rests.set(key, until);
    for (const [hour, amount] of this.neurons) copy.neurons.set(hour, amount);
    return copy;
  }

  private restUntil(model: ModelAllowance): number | undefined {
    return this.rests.get(`${model.provider}/${model.model}`);
  }

  requestsLeft(model: ModelAllowance, time: number): number {
    const rest = this.restUntil(model);
    if (rest !== undefined && time < rest) return 0;
    const used = usedAt(this.series(model.provider, model.model), time);
    return Math.max(0, model.requestsPerDay - used);
  }

  useRequests(model: ModelAllowance, time: number, count: number): void {
    add(this.series(model.provider, model.model), hourStart(time), count);
  }

  // A resting model frees up when its rest ends, whatever its own count says before then
  nextRequestRelease(model: ModelAllowance, time: number): number | undefined {
    const rest = this.restUntil(model);
    if (rest !== undefined && time < rest) return rest;
    return nextRelease(this.series(model.provider, model.model), time);
  }

  neuronsLeft(time: number): number {
    const budget = this.config.embeddings?.dailyNeuronBudget;
    return budget === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, budget - usedAt(this.neurons, time));
  }

  useNeurons(time: number, amount: number): void {
    add(this.neurons, hourStart(time), amount);
  }

  nextNeuronRelease(time: number): number | undefined {
    return nextRelease(this.neurons, time);
  }
}

// Models that can take a task's calls at all, in the router's order
export function modelsFor(config: CapacityConfig, task: string): ModelAllowance[] {
  const needed = TASK_CALL_TOKENS[task] ?? 0;
  return (config.tasks[task] ?? []).flatMap((id) => {
    const model = config.models.find((candidate) => candidate.id === id);
    return model && model.tokensPerMinute >= needed ? [model] : [];
  });
}

// Steps through releases until the check passes; a day of hourly releases is always enough
function firstTime(
  start: number,
  ready: (time: number) => boolean,
  release: (time: number) => number | undefined,
): number | undefined {
  let time = start;
  for (let step = 0; step < 48; step += 1) {
    if (ready(time)) return time;
    const next = release(time);
    if (next === undefined) return undefined;
    time = next;
  }
  return undefined;
}

// When the next call for a task can start, or undefined when no configured model can ever take it
export function taskCapacityAt(
  ledger: CapacityLedger,
  task: string,
  time: number,
): number | undefined {
  const models = modelsFor(ledger.config, task);
  if (models.length === 0) return undefined;
  return firstTime(
    time,
    (at) => models.some((model) => ledger.requestsLeft(model, at) > 0),
    (at) => {
      const releases = models
        .map((model) => ledger.nextRequestRelease(model, at))
        .filter((release): release is number => release !== undefined);
      return releases.length > 0 ? Math.min(...releases) : undefined;
    },
  );
}

// When at least the given number of neurons is free, so a sliver of leftover allowance does not count
export function neuronCapacityAt(
  ledger: CapacityLedger,
  time: number,
  minimum = 1,
): number | undefined {
  return firstTime(
    time,
    (at) => ledger.neuronsLeft(at) >= minimum,
    (at) => ledger.nextNeuronRelease(at),
  );
}
