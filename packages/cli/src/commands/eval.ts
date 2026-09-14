import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { formatRepoRef, parseRepoRef, repoDirName } from "@everyrepo/core";
import {
  EmbeddingCache,
  engineDbPath,
  findRepo,
  openEngineDb,
  queryCachePath,
} from "@everyrepo/db";
import { fromBlob, toBlob, type Embedder } from "@everyrepo/embed";
import {
  distinctPaths,
  loadGoldSets,
  scoreQuestion,
  summarize,
  type QuestionScore,
} from "@everyrepo/eval";
import {
  loadVectorIndex,
  searchHybrid,
  searchKeyword,
  searchVector,
  type SearchHit,
} from "@everyrepo/search";
import { Command } from "commander";
import { openContext, openEmbedder } from "../context.ts";

const MODES = ["keyword", "vector", "hybrid"] as const;
type Mode = (typeof MODES)[number];
const CANDIDATE_CHUNKS = 50;

interface EvalOptions {
  modes: string;
  dims?: string;
  details: boolean;
  out?: string;
}

interface QuestionResult {
  repo: string;
  id: string;
  type: string;
  question: string;
  expected: string[];
  mode: Mode;
  score: QuestionScore;
  top: string[];
}

// Re-running the eval reuses question vectors instead of paying for them again
async function embedQueries(
  embedder: Embedder,
  cache: EmbeddingCache,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const hashes = texts.map((text) =>
    createHash("sha256").update(`query\n${text}`).digest().subarray(0, 16),
  );
  const found = cache.getMany(embedder.model, hashes);
  const missing = hashes.flatMap((hash, index) => (found.has(hash.toString("hex")) ? [] : [index]));
  if (missing.length > 0) {
    const vectors = await embedder.embed(
      missing.map((index) => texts[index]!),
      "query",
    );
    const entries = missing.map(
      (index, position) => [hashes[index]!, toBlob(vectors[position]!)] as const,
    );
    cache.putMany(embedder.model, entries);
    for (const [hash, blob] of entries) found.set(hash.toString("hex"), blob);
  }
  return hashes.map((hash) => fromBlob(found.get(hash.toString("hex"))!));
}

function formatRow(cells: Array<string | number>): string {
  const widths = [36, 8, 5, 6, 6, 7, 6];
  return cells
    .map((cell, index) => {
      const text = typeof cell === "number" ? cell.toFixed(2) : cell;
      return index === 0 ? text.padEnd(widths[index]!) : text.padStart(widths[index]!);
    })
    .join(" ");
}

export function evalCommand(): Command {
  return new Command("eval")
    .description("Measure retrieval quality against the gold question sets")
    .argument("[repos...]", "limit to these repositories")
    .option("--modes <list>", "comma separated: keyword, vector, hybrid", MODES.join(","))
    .option("--dims <n>", "truncate vectors to this many dimensions")
    .option("--details", "print the rank of every question", false)
    .option("--out <file>", "write per-question results as JSON")
    .action(async (repoArgs: string[], options: EvalOptions) => {
      const modes = options.modes.split(",").map((mode) => mode.trim()) as Mode[];
      for (const mode of modes) {
        if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}"`);
      }
      const wanted = new Set(repoArgs.map((arg) => formatRepoRef(parseRepoRef(arg)).toLowerCase()));
      const sets = (await loadGoldSets()).filter(
        (set) =>
          wanted.size === 0 || wanted.has(formatRepoRef(parseRepoRef(set.repo)).toLowerCase()),
      );
      const context = await openContext();
      const needsVectors = modes.some((mode) => mode !== "keyword");
      const configured = needsVectors ? await openEmbedder(context) : undefined;
      const queryCache = configured
        ? new EmbeddingCache(queryCachePath(context.config.dataDir))
        : undefined;
      if (needsVectors && !configured)
        throw new Error("Vector modes need embeddings in the config");
      const results: QuestionResult[] = [];
      try {
        console.log(formatRow(["repo", "mode", "n", "R@5", "R@10", "Hit@10", "MRR"]));
        for (const set of sets) {
          const ref = parseRepoRef(set.repo);
          const repo = findRepo(context.appDb, ref);
          if (!repo?.lastIndexedSha) {
            console.log(`${set.repo}: not indexed, skipped`);
            continue;
          }
          if (repo.lastIndexedSha !== set.sha) {
            console.log(
              `${set.repo}: indexed ${repo.lastIndexedSha.slice(0, 10)}, gold set written for ${set.sha.slice(0, 10)}`,
            );
          }
          const engine = openEngineDb(
            engineDbPath(context.config.dataDir, repoDirName(ref), repo.lastIndexedSha),
          );
          try {
            const index = needsVectors
              ? loadVectorIndex(engine, options.dims ? Number(options.dims) : undefined)
              : undefined;
            if (index && index.chunkIds.length === 0) {
              console.log(`${set.repo}: no chunk vectors, run the embed stage first`);
              continue;
            }
            const queries =
              configured && queryCache
                ? await embedQueries(
                    configured.embedder,
                    queryCache,
                    set.questions.map((question) => question.question),
                  )
                : [];
            for (const mode of modes) {
              const scores: QuestionScore[] = [];
              for (const [position, question] of set.questions.entries()) {
                let hits: SearchHit[];
                if (mode === "keyword") {
                  hits = searchKeyword(engine, question.question, CANDIDATE_CHUNKS);
                } else if (mode === "vector") {
                  hits = searchVector(engine, index!, queries[position]!, CANDIDATE_CHUNKS);
                } else {
                  hits = searchHybrid(
                    engine,
                    index!,
                    question.question,
                    queries[position]!,
                    CANDIDATE_CHUNKS,
                  );
                }
                const ranked = distinctPaths(hits);
                const score = scoreQuestion(question.expected, ranked);
                scores.push(score);
                results.push({
                  repo: set.repo,
                  id: question.id,
                  type: question.type,
                  question: question.question,
                  expected: question.expected,
                  mode,
                  score,
                  top: ranked.slice(0, 5),
                });
                if (options.details) {
                  console.log(
                    `  ${question.id.padEnd(24)} ${mode.padEnd(8)} rank ${String(score.firstRank ?? "-").padStart(3)}  ${question.question}`,
                  );
                }
              }
              const summary = summarize(scores);
              console.log(
                formatRow([
                  set.repo,
                  mode,
                  String(summary.questions),
                  summary.recallAt5,
                  summary.recallAt10,
                  summary.hitAt10,
                  summary.reciprocalRank,
                ]),
              );
            }
          } finally {
            engine.$client.close();
          }
        }
        for (const mode of modes) {
          const summary = summarize(
            results.filter((result) => result.mode === mode).map((result) => result.score),
          );
          console.log(
            formatRow([
              "all",
              mode,
              String(summary.questions),
              summary.recallAt5,
              summary.recallAt10,
              summary.hitAt10,
              summary.reciprocalRank,
            ]),
          );
        }
        if (options.out) await writeFile(options.out, JSON.stringify(results, null, 2));
      } finally {
        configured?.server.stop();
        queryCache?.close();
        context.close();
      }
    });
}
