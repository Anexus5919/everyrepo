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
import { fromBlob, toBlob, type Embedder, type Reranker } from "@everyrepo/embed";
import {
  distinctPaths,
  loadGoldSets,
  scoreQuestion,
  summarize,
  type QuestionScore,
} from "@everyrepo/eval";
import {
  applyRerank,
  filePassages,
  loadVectorIndex,
  rankFiles,
  searchHybrid,
  searchKeyword,
  searchVector,
  type SearchHit,
} from "@everyrepo/search";
import { Command } from "commander";
import { openContext, openEmbedder, openReranker } from "../context.ts";

const MODES = ["keyword", "vector", "hybrid", "files", "rerank"] as const;
type BaseMode = (typeof MODES)[number];
// Rerank runs once per blend value, so its results are labelled with the blend
type Mode = Exclude<BaseMode, "rerank"> | `rerank@${string}`;
const CANDIDATE_CHUNKS = 50;

interface EvalOptions {
  modes: string;
  dims?: string;
  candidates: string;
  vectorWeight: string;
  decay: string;
  centrality: string;
  docsWeight: string;
  neighbors: string;
  neighborSources: string;
  dampen: boolean;
  rerankTop: string;
  rerankBlend: string;
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
  getEmbedder: () => Promise<Embedder>,
  model: string,
  cache: EmbeddingCache,
  texts: readonly string[],
): Promise<Float32Array[]> {
  const hashes = texts.map((text) =>
    createHash("sha256").update(`query\n${text}`).digest().subarray(0, 16),
  );
  const found = cache.getMany(model, hashes);
  const missing = hashes.flatMap((hash, index) => (found.has(hash.toString("hex")) ? [] : [index]));
  if (missing.length > 0) {
    const vectors = await (
      await getEmbedder()
    ).embed(
      missing.map((index) => texts[index]!),
      "query",
    );
    const entries = missing.map(
      (index, position) => [hashes[index]!, toBlob(vectors[position]!)] as const,
    );
    cache.putMany(model, entries);
    for (const [hash, blob] of entries) found.set(hash.toString("hex"), blob);
  }
  return hashes.map((hash) => fromBlob(found.get(hash.toString("hex"))!));
}

// Reranker scores are cached by query and passages, so trying other blends costs nothing
async function rerankScores(
  getReranker: () => Reranker,
  cache: EmbeddingCache,
  query: string,
  passages: readonly string[],
): Promise<number[]> {
  const reranker = getReranker();
  const hash = createHash("sha256")
    .update(JSON.stringify([reranker.model, query, passages]))
    .digest()
    .subarray(0, 16);
  const key = `${reranker.model}:rerank`;
  const found = cache.getMany(key, [hash]).get(hash.toString("hex"));
  if (found) return [...fromBlob(found)];
  const scores = await reranker.rerank(query, passages);
  cache.putMany(key, [[hash, toBlob(Float32Array.from(scores))]]);
  return scores;
}

function formatRow(cells: Array<string | number>): string {
  const widths = [36, 12, 5, 6, 6, 7, 6];
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
    .option(
      "--modes <list>",
      "comma separated: keyword, vector, hybrid, files, rerank",
      "keyword,hybrid,files",
    )
    .option("--dims <n>", "truncate vectors to this many dimensions")
    .option("--candidates <n>", "chunks taken from each list before fusion", "100")
    .option("--vector-weight <w>", "weight of the vector list in hybrid fusion", "2")
    .option("--decay <list>", "files mode: weights of a file's best chunks", "1")
    .option("--centrality <w>", "files mode: boost for central files", "0.25")
    .option("--docs-weight <w>", "files mode: multiplier for documentation files", "0.9")
    .option("--neighbors <w>", "files mode: share of score passed to imported files", "0.25")
    .option("--neighbor-sources <n>", "files mode: top files that pass score", "10")
    .option("--no-dampen", "files mode: do not dampen widely imported files")
    .option("--rerank-top <n>", "rerank mode: top files sent to the reranker", "30")
    .option(
      "--rerank-blend <list>",
      "rerank mode: comma separated weights of the reranker order, 1 uses it alone",
      "1",
    )
    .option("--details", "print the rank of every question", false)
    .option("--out <file>", "write per-question results as JSON")
    .action(async (repoArgs: string[], options: EvalOptions) => {
      const requested = options.modes.split(",").map((mode) => mode.trim()) as BaseMode[];
      for (const mode of requested) {
        if (!MODES.includes(mode)) throw new Error(`Unknown mode "${mode}"`);
      }
      const blends = options.rerankBlend.split(",").map((value) => value.trim());
      const modes: Mode[] = requested.flatMap((mode): Mode[] =>
        mode === "rerank" ? blends.map((blend): Mode => `rerank@${blend}`) : [mode],
      );
      const wanted = new Set(repoArgs.map((arg) => formatRepoRef(parseRepoRef(arg)).toLowerCase()));
      const sets = (await loadGoldSets()).filter(
        (set) =>
          wanted.size === 0 || wanted.has(formatRepoRef(parseRepoRef(set.repo)).toLowerCase()),
      );
      const context = await openContext();
      const needsVectors = modes.some((mode) => mode !== "keyword");
      const embeddings = context.config.embeddings;
      if (needsVectors && !embeddings)
        throw new Error("Vector modes need embeddings in the config");
      const queryCache = needsVectors
        ? new EmbeddingCache(queryCachePath(context.config.dataDir))
        : undefined;
      let configured: Awaited<ReturnType<typeof openEmbedder>>;
      let reranker: Reranker | undefined;
      const getReranker = () => (reranker ??= openReranker(context));
      const getEmbedder = async () => {
        configured ??= await openEmbedder(context);
        if (!configured) throw new Error("Vector modes need embeddings in the config");
        return configured.embedder;
      };
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
              embeddings && queryCache
                ? await embedQueries(
                    getEmbedder,
                    embeddings.model,
                    queryCache,
                    set.questions.map((question) => question.question),
                  )
                : [];
            for (const mode of modes) {
              const scores: QuestionScore[] = [];
              for (const [position, question] of set.questions.entries()) {
                let hits: Array<Pick<SearchHit, "path">>;
                if (mode === "files" || mode.startsWith("rerank@")) {
                  const fileHits = rankFiles(
                    engine,
                    index!,
                    question.question,
                    queries[position]!,
                    {
                      limit: CANDIDATE_CHUNKS,
                      candidates: Number(options.candidates),
                      vectorWeight: Number(options.vectorWeight),
                      chunkDecay: options.decay.split(",").map(Number),
                      centralityWeight: Number(options.centrality),
                      docsWeight: Number(options.docsWeight),
                      neighborWeight: Number(options.neighbors),
                      neighborSources: Number(options.neighborSources),
                      dampenPopular: options.dampen,
                    },
                  );
                  hits = fileHits;
                  if (mode.startsWith("rerank@")) {
                    const top = Number(options.rerankTop);
                    const scores = await rerankScores(
                      getReranker,
                      queryCache!,
                      question.question,
                      filePassages(engine, fileHits.slice(0, top)),
                    );
                    hits = applyRerank(fileHits, scores, {
                      top,
                      blend: Number(mode.slice("rerank@".length)),
                    });
                  }
                } else if (mode === "keyword") {
                  hits = searchKeyword(engine, question.question, CANDIDATE_CHUNKS);
                } else if (mode === "vector") {
                  hits = searchVector(engine, index!, queries[position]!, CANDIDATE_CHUNKS);
                } else {
                  hits = searchHybrid(engine, index!, question.question, queries[position]!, {
                    limit: CANDIDATE_CHUNKS,
                    candidates: Number(options.candidates),
                    vectorWeight: Number(options.vectorWeight),
                  });
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
