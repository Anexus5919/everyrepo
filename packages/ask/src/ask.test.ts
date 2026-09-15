import { openEngineDb, type EngineDb } from "@everyrepo/db";
import { LlmRouter, type ChatModel, type ChatRequest } from "@everyrepo/llm";
import type { VectorIndex } from "@everyrepo/search";
import { describe, expect, it } from "vitest";
import {
  askQuestion,
  AskInputError,
  cleanQuestion,
  normalizeAnswer,
  type AskEvent,
} from "./answer.ts";
import { trimExcerpt } from "./retrieve.ts";

const SHA = "a".repeat(40);

const FILES = [
  {
    path: "src/config/load.ts",
    header: "src/config/load.ts defines loadConfig",
    content:
      "export function loadConfig(env) {\n  const port = Number(env.PORT);\n  return { port };\n}",
    vector: [1, 0, 0],
  },
  {
    path: "src/server.ts",
    header: "src/server.ts defines startServer",
    content: "export function startServer(config) {\n  listen(config.port);\n}",
    vector: [0, 1, 0],
  },
  {
    path: "src/render.ts",
    header: "src/render.ts defines render",
    content: "export function render(view) {\n  return view.html;\n}",
    vector: [0, 0, 1],
  },
];

function buildEngine(): { engine: EngineDb; index: VectorIndex } {
  const engine = openEngineDb(":memory:");
  const sql = engine.$client;
  const insertFile = sql.prepare(
    "INSERT INTO file (path, oid, bytes, tokens, kind) VALUES (?, 'oid', 100, 20, 'src')",
  );
  const insertChunk = sql.prepare(
    `INSERT INTO chunk (file_id, start_line, end_line, kind, header, content, identifiers, tokens)
     VALUES (?, 10, 13, 'code', ?, ?, ?, 20)`,
  );
  const chunkIds: number[] = [];
  for (const file of FILES) {
    const fileId = Number(insertFile.run(file.path).lastInsertRowid);
    const identifiers = file.header.split(" ").pop() ?? "";
    chunkIds.push(
      Number(insertChunk.run(fileId, file.header, file.content, identifiers).lastInsertRowid),
    );
  }
  sql.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')").run();
  sql
    .prepare(
      `INSERT INTO wiki_page (slug, position, title, purpose, clusters, files, status, updated_at)
       VALUES (?, ?, ?, 'Purpose', '[]', ?, 'written', 0)`,
    )
    .run("configuration", 1, "Configuration", JSON.stringify(["src/config/load.ts"]));
  sql
    .prepare(
      `INSERT INTO wiki_page (slug, position, title, purpose, clusters, files, status, updated_at)
       VALUES (?, ?, ?, 'Purpose', '[]', ?, 'written', 0)`,
    )
    .run("rendering", 2, "Rendering", JSON.stringify(["src/render.ts"]));
  return {
    engine,
    index: {
      chunkIds: Int32Array.from(chunkIds),
      dimensions: 3,
      matrix: Float32Array.from(FILES.flatMap((file) => file.vector)),
    },
  };
}

function fakeRouter(reply: (request: ChatRequest) => string): LlmRouter {
  const model: ChatModel = {
    id: "fake",
    provider: "test",
    model: "fake-model",
    limits: { requestsPerMinute: 100, tokensPerMinute: 100_000, requestsPerDay: 1_000 },
    complete: async (request) => ({
      text: reply(request),
      provider: "test",
      model: "fake-model",
      inputTokens: 0,
      outputTokens: 0,
      cached: false,
    }),
  };
  return new LlmRouter({ ask: [model] });
}

// The label the prompt gave to a file, so replies can cite it
const labelFor = (request: ChatRequest, path: string) =>
  new RegExp(`\\[(S\\d+)\\] ${path.replaceAll(".", "\\.")}`).exec(
    request.messages[1]!.content,
  )?.[1];

describe("askQuestion", () => {
  it("answers from cited sources, drops uncited text and links pinned lines", async () => {
    const { engine, index } = buildEngine();
    const events: AskEvent["type"][] = [];
    let prompt = "";
    const answer = await askQuestion({
      engine,
      index,
      router: fakeRouter((request) => {
        prompt = request.messages[1]!.content;
        const label = labelFor(request, "src/config/load.ts");
        return `The port comes from \`loadConfig\`, which reads \`PORT\` from the environment [${label}].\n\nIt also caches values forever.`;
      }),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
      repo: "acme/app",
      sha: SHA,
      question: "  Where is   the port loaded? ",
      onEvent: (event) => events.push(event.type),
    });

    expect(events).toEqual(["searching", "reading", "writing"]);
    expect(prompt).toContain("Question: Where is the port loaded?");
    expect(answer.status).toBe("answered");
    expect(answer.markdown).toContain("`loadConfig`");
    expect(answer.markdown).not.toContain("caches values forever");
    expect(answer.sources).toHaveLength(1);
    expect(answer.sources[0]).toMatchObject({
      number: 1,
      path: "src/config/load.ts",
      url: `https://github.com/acme/app/blob/${SHA}/src/config/load.ts#L10-L13`,
    });
    expect(answer.markdown).toContain(`[[1]](${answer.sources[0]!.url})`);
    expect(answer.pages[0]).toEqual({ slug: "configuration", title: "Configuration" });
    engine.$client.close();
  });

  it("reports a question the sources cannot answer and lists what was read", async () => {
    const { engine, index } = buildEngine();
    const answer = await askQuestion({
      engine,
      index,
      router: fakeRouter(() => "NOT_FOUND"),
      embedQuery: async () => Float32Array.from([0, 0, 1]),
      repo: "acme/app",
      sha: SHA,
      question: "How are views rendered?",
    });
    expect(answer.status).toBe("not-found");
    expect(answer.markdown).toBe("");
    expect(answer.files.map((file) => file.path)).toContain("src/render.ts");
    engine.$client.close();
  });

  it("rejects questions that are too short or too long", () => {
    expect(() => cleanQuestion(" a ")).toThrow(AskInputError);
    expect(() => cleanQuestion("x".repeat(301))).toThrow(AskInputError);
  });
});

describe("normalizeAnswer", () => {
  it("restores plain hyphens and moves citations off closing code fences", () => {
    expect(normalizeAnswer("from `markdown\u2011transform` [S2]")).toBe(
      "from `markdown-transform` [S2]",
    );
    expect(normalizeAnswer("```ts\nrun();\n``` [S4]\n\nNext [S1]")).toBe(
      "```ts\nrun();\n```\n\nNext [S1]",
    );
  });
});

describe("trimExcerpt", () => {
  it("cuts at whole lines and moves the end line", () => {
    const row = {
      id: 1,
      path: "a.ts",
      startLine: 5,
      endLine: 9,
      content: "aaaa\nbbbb\ncccc\ndddd\neeee",
    };
    expect(trimExcerpt(row, 12)).toMatchObject({ content: "aaaa\nbbbb", endLine: 6 });
    expect(trimExcerpt(row, 100)).toBe(row);
  });
});
