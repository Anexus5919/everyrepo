import { createHash } from "node:crypto";
import {
  askQuestion,
  AskInputError,
  createGithubIssues,
  type AskAnswer,
  type AskDiagram,
  type AskEvent,
  type AskTurn,
} from "@everyrepo/ask";
import { parseRepoRef, repoDirName } from "@everyrepo/core";
import {
  EmbeddingCache,
  engineDbPath,
  findRepo,
  openEngineDb,
  queryCachePath,
  repos,
  type EngineDb,
} from "@everyrepo/db";
import { fromBlob, toBlob } from "@everyrepo/embed";
import { loadVectorIndex, type VectorIndex } from "@everyrepo/search";
import { openEmbedder, openLlm, type CliContext } from "./context.ts";

export interface AskRequest {
  repo: string;
  question: string;
  // Slug of the wiki page the reader is on
  page?: string | null;
  history?: AskTurn[];
  diagram?: AskDiagram | null;
}

export interface AskSession {
  ask(request: AskRequest, onEvent?: (event: AskEvent) => void): Promise<AskAnswer>;
  // Repositories that have an index to answer from
  repos(): Array<{ repo: string; sha: string }>;
  close(): void;
}

interface Snapshot {
  sha: string;
  engine: EngineDb;
  index: VectorIndex;
}

// Vector matrices of large repositories take hundreds of megabytes, so only a few stay loaded
const LOADED_SNAPSHOTS = 2;

export async function openAskSession(context: CliContext): Promise<AskSession> {
  const configured = await openEmbedder(context);
  if (!configured) throw new Error("Ask needs an embeddings section in the local config");
  const { embedder } = configured;
  const llm = openLlm(context);
  const queries = new EmbeddingCache(queryCachePath(context.config.dataDir));
  const loaded = new Map<string, Snapshot>();
  // A token raises the GitHub rate limit but is optional for public issues
  const githubToken = process.env["GITHUB_TOKEN"];
  const issues = createGithubIssues(githubToken ? { token: githubToken } : {});

  // Repeated questions reuse their stored vector instead of paying for it again
  async function embedQuery(text: string): Promise<Float32Array> {
    const hash = createHash("sha256").update(`query\n${text}`).digest().subarray(0, 16);
    const stored = queries.getMany(embedder.model, [hash]).get(hash.toString("hex"));
    if (stored) return fromBlob(stored);
    const [vector] = await embedder.embed([text], "query");
    if (!vector) throw new Error("The embedding provider returned no vector");
    queries.putMany(embedder.model, [[hash, toBlob(vector)]]);
    return vector;
  }

  function snapshotFor(repoKey: string, sha: string, dirName: string): Snapshot {
    const existing = loaded.get(repoKey);
    if (existing?.sha === sha) {
      loaded.delete(repoKey);
      loaded.set(repoKey, existing);
      return existing;
    }
    existing?.engine.$client.close();
    loaded.delete(repoKey);
    const engine = openEngineDb(engineDbPath(context.config.dataDir, dirName, sha));
    const index = loadVectorIndex(engine, context.config.embeddings?.dimensions);
    const snapshot = { sha, engine, index };
    loaded.set(repoKey, snapshot);
    while (loaded.size > LOADED_SNAPSHOTS) {
      const [oldest, value] = loaded.entries().next().value!;
      value.engine.$client.close();
      loaded.delete(oldest);
    }
    return snapshot;
  }

  return {
    async ask({ repo: repoArg, question, page, history, diagram }, onEvent) {
      let ref;
      try {
        ref = parseRepoRef(repoArg);
      } catch {
        throw new AskInputError("Name the repository as owner/repo.");
      }
      const row = findRepo(context.appDb, ref);
      if (!row?.lastIndexedSha) {
        throw new AskInputError(`${repoArg} has not been read yet.`);
      }
      const snapshot = snapshotFor(
        row.key,
        row.lastIndexedSha,
        repoDirName(parseRepoRef(row.fullName)),
      );
      if (snapshot.index.chunkIds.length === 0) {
        throw new AskInputError(`${row.fullName} has no search index yet.`);
      }
      return askQuestion({
        engine: snapshot.engine,
        index: snapshot.index,
        router: llm.router,
        embedQuery,
        repo: row.fullName,
        sha: snapshot.sha,
        question,
        page: page ?? null,
        history: history ?? [],
        diagram: diagram ?? null,
        issues,
        ...(onEvent ? { onEvent } : {}),
      });
    },
    repos() {
      return context.appDb
        .select({ repo: repos.fullName, sha: repos.lastIndexedSha })
        .from(repos)
        .all()
        .flatMap((row) => (row.sha ? [{ repo: row.repo, sha: row.sha }] : []));
    },
    close() {
      for (const snapshot of loaded.values()) snapshot.engine.$client.close();
      loaded.clear();
      queries.close();
      llm.close();
      configured.server.stop();
    },
  };
}
