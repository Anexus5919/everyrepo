import { openEngineDb, type EngineDb } from "@everyrepo/db";
import { LlmRouter, type ChatModel, type ChatRequest } from "@everyrepo/llm";
import type { VectorIndex } from "@everyrepo/search";
import { describe, expect, it } from "vitest";
import {
  askQuestion,
  AskInputError,
  citeCopiedCode,
  cleanQuestion,
  normalizeAnswer,
  type AskEvent,
} from "./answer.ts";
import {
  createGithubIssues,
  rankNewcomerIssues,
  type GithubIssue,
  type IssueSource,
} from "./issues.ts";
import { heuristicPlan } from "./plan.ts";
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
    path: "src/render.ts",
    header: "src/render.ts defines render",
    content: "export function render(view) {\n  return view.html;\n}",
    vector: [0, 1, 0],
  },
  {
    path: "README.md",
    header: "README.md: Acme app",
    content:
      "# Acme app\n\nAcme app serves configurable views for small teams and loads its settings from the environment.",
    vector: [0, 0, 1],
  },
  {
    path: "CONTRIBUTING.md",
    header: "CONTRIBUTING.md: Contributing",
    content:
      "# Contributing\n\nRun pnpm install, then pnpm test before opening a pull request against the main branch.",
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
  const insertPage = sql.prepare(
    `INSERT INTO wiki_page (slug, position, title, purpose, clusters, files, status, markdown, updated_at)
     VALUES (?, ?, ?, ?, '[]', ?, 'written', ?, 0)`,
  );
  insertPage.run(
    "overview",
    0,
    "Overview",
    "What Acme app is.",
    "[]",
    "Acme app renders views from settings [[1]](https://github.com/acme/app/blob/x/README.md#L1-L3).",
  );
  insertPage.run(
    "configuration",
    1,
    "Configuration",
    "How settings are loaded.",
    JSON.stringify(["src/config/load.ts"]),
    "Settings come from `loadConfig`.",
  );
  sql
    .prepare(
      `INSERT INTO summary (level, target, prompt_version, input_hash, provider, model, content, input_tokens, output_tokens, created_at)
       VALUES ('repo', 'repo', 'repo-1', 'h', 'test', 'test', ?, 0, 0, 0)`,
    )
    .run(
      JSON.stringify({
        summary: "Acme app serves configurable views.",
        overview: "It loads settings and renders views for small teams.",
        architecture: "A config loader feeds a renderer.",
        technologies: ["TypeScript"],
        mainAreas: [{ title: "Configuration", description: "Loads settings." }],
      }),
    );
  return {
    engine,
    index: {
      chunkIds: Int32Array.from(chunkIds),
      dimensions: 3,
      matrix: Float32Array.from(FILES.flatMap((file) => file.vector)),
    },
  };
}

interface FakeReplies {
  plan: (request: ChatRequest) => string;
  answer: (request: ChatRequest) => string;
}

function fakeRouter(replies: FakeReplies, calls: string[] = []): LlmRouter {
  const model: ChatModel = {
    id: "fake",
    provider: "test",
    model: "fake-model",
    limits: { requestsPerMinute: 100, tokensPerMinute: 100_000, requestsPerDay: 1_000 },
    complete: async (request) => {
      const planning = request.messages[0]!.content.includes("decide how they should be answered");
      calls.push(planning ? "plan" : "answer");
      return {
        text: planning ? replies.plan(request) : replies.answer(request),
        provider: "test",
        model: "fake-model",
        inputTokens: 0,
        outputTokens: 0,
        cached: false,
      };
    },
  };
  return new LlmRouter({ ask: [model] });
}

const plan =
  (intent: string, question: string, extra: Record<string, unknown> = {}) =>
  () =>
    JSON.stringify({ intent, question, search: question, level: "unknown", issue: null, ...extra });

// The label the prompt gave to a source title, so replies can cite it
const labelFor = (request: ChatRequest, title: string) =>
  new RegExp(`\\[(S\\d+)\\] ${title.replace(/[.#]/g, "\\$&")}`).exec(
    request.messages[1]!.content,
  )?.[1];

const issue = (number: number, overrides: Partial<GithubIssue> = {}): GithubIssue => ({
  number,
  title: `Port is ignored when set to zero ${number}`,
  url: `https://github.com/acme/app/issues/${number}`,
  labels: ["good first issue", "bug"],
  comments: 2,
  reactions: 3,
  createdAt: "2026-08-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  body: "<!-- template -->Setting PORT=0 in the environment is ignored by the config loader, so the app keeps the default port.",
  open: true,
  ...overrides,
});

describe("askQuestion", () => {
  it("answers code questions with the page and conversation in view", async () => {
    const { engine, index } = buildEngine();
    const events: AskEvent[] = [];
    const prompts: string[] = [];
    const answer = await askQuestion({
      engine,
      index,
      router: fakeRouter({
        plan: (request) => {
          prompts.push(request.messages[1]!.content);
          return plan("code", "Where does the configuration page load the port?")();
        },
        answer: (request) => {
          prompts.push(request.messages[1]!.content);
          const label = labelFor(request, "src/config/load.ts");
          return `The port comes from \`loadConfig\`, which reads \`PORT\` [${label}].\n\nIt also caches values forever.`;
        },
      }),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
      repo: "acme/app",
      sha: SHA,
      question: "  where is the port read here? ",
      page: "configuration",
      history: [{ question: "What is this app?", answer: "It serves views [[1]](https://x)." }],
      onEvent: (event) => events.push(event),
    });

    expect(events.map((event) => event.stage)).toEqual([
      "understanding",
      "searching",
      "reading",
      "writing",
    ]);
    expect(prompts[0]).toContain('The reader is on the wiki page "Configuration"');
    expect(prompts[0]).toContain("Reader: What is this app?\nAnswer: It serves views .");
    expect(prompts[1]).toContain("Question: Where does the configuration page load the port?");
    expect(answer).toMatchObject({ status: "answered", intent: "code" });
    expect(answer.markdown).not.toContain("caches values forever");
    expect(answer.sources[0]).toMatchObject({
      number: 1,
      kind: "code",
      path: "src/config/load.ts",
      url: `https://github.com/acme/app/blob/${SHA}/src/config/load.ts#L10-L13`,
    });
    expect(answer.pages[0]).toEqual({ slug: "configuration", title: "Configuration" });
    engine.$client.close();
  });

  it("answers overview questions from the wiki with links to its pages", async () => {
    const { engine, index } = buildEngine();
    const answer = await askQuestion({
      engine,
      index,
      router: fakeRouter({
        plan: plan("overview", "What is acme/app about?"),
        answer: (request) =>
          `Acme app serves configurable views for small teams [${labelFor(request, "Repository overview")}, ${labelFor(request, "Overview")}].`,
      }),
      embedQuery: async () => Float32Array.from([0, 0, 1]),
      repo: "acme/app",
      sha: SHA,
      question: "what is this repo about",
    });
    expect(answer.status).toBe("answered");
    expect(answer.sources.map((source) => [source.kind, source.url])).toEqual([
      ["summary", "/acme/app"],
      ["page", "/acme/app/overview"],
    ]);
    engine.$client.close();
  });

  it("suggests a newcomer issue and explains it with the code it touches", async () => {
    const { engine, index } = buildEngine();
    const issues: IssueSource = {
      newcomerIssues: async () => [issue(12), issue(7), issue(3)],
      issue: async () => null,
    };
    let prompt = "";
    const answer = await askQuestion({
      engine,
      index,
      issues,
      router: fakeRouter({
        plan: plan("contribute", "Which issue can a beginner work on?", { level: "beginner" }),
        answer: (request) => {
          prompt = request.messages[1]!.content;
          const issueLabel = labelFor(request, "#12");
          const code = labelFor(request, "src/config/load.ts");
          const guide = labelFor(request, "CONTRIBUTING.md");
          return [
            `Issue #12 reports that PORT=0 is ignored [${issueLabel}].`,
            `It is a small bug with 3 reactions, so the impact looks limited [${issueLabel}].`,
            `The likely place to change is \`loadConfig\` [${code}].`,
            `Start with pnpm install and pnpm test [${guide}].`,
          ].join("\n\n");
        },
      }),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
      repo: "acme/app",
      sha: SHA,
      question: "I am a beginner, which issue can I work on?",
    });
    expect(prompt).toContain("Source S1 is GitHub issue #12");
    expect(prompt).toContain("The reader says they are new");
    expect(prompt).not.toContain("<!-- template -->");
    expect(answer).toMatchObject({ status: "answered", intent: "contribute" });
    expect(answer.issue?.number).toBe(12);
    expect(answer.otherIssues.map((item) => item.number)).toEqual([7, 3]);
    expect(answer.sources[0]).toMatchObject({
      kind: "issue",
      url: "https://github.com/acme/app/issues/12",
    });
    expect(answer.sources.map((source) => source.path)).toEqual(
      expect.arrayContaining(["src/config/load.ts", "CONTRIBUTING.md"]),
    );
    engine.$client.close();
  });

  it("does not answer questions about other things", async () => {
    const { engine, index } = buildEngine();
    const calls: string[] = [];
    const answer = await askQuestion({
      engine,
      index,
      router: fakeRouter(
        { plan: plan("general", "How do I center a div?"), answer: () => "unused" },
        calls,
      ),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
      repo: "acme/app",
      sha: SHA,
      question: "give the code for center a div",
    });
    expect(answer.status).toBe("off-topic");
    expect(answer.note).toContain("acme/app");
    expect(calls).toEqual(["plan"]);
    engine.$client.close();
  });

  it("falls back to keyword rules when planning fails", async () => {
    const { engine, index } = buildEngine();
    const answer = await askQuestion({
      engine,
      index,
      issues: { newcomerIssues: async () => [], issue: async () => null },
      router: fakeRouter({ plan: () => "not json", answer: () => "unused" }),
      embedQuery: async () => Float32Array.from([1, 0, 0]),
      repo: "acme/app",
      sha: SHA,
      question: "Is there a good first issue for me?",
    });
    expect(answer).toMatchObject({ intent: "contribute", status: "not-found" });
    expect(answer.note).toContain("No open issues");
    engine.$client.close();
  });

  it("rejects questions that are too short or too long", () => {
    expect(() => cleanQuestion(" a ")).toThrow(AskInputError);
    expect(() => cleanQuestion("x".repeat(301))).toThrow(AskInputError);
  });
});

describe("answer clean up", () => {
  it("restores plain hyphens and keeps citations placed after code fences", () => {
    expect(normalizeAnswer("from `markdown\u2011transform` [S2]")).toBe(
      "from `markdown-transform` [S2]",
    );
    expect(normalizeAnswer("```ts\nrun();\n``` [S4]\n\nNext [S1]")).toBe(
      "```ts\nrun();\n```\n\nCopied from [S4].\n\nNext [S1]",
    );
  });

  it("cites the source a code block was copied from", () => {
    const sources = [
      { label: "S1", chunkId: 1, path: "a.ts", startLine: 1, endLine: 2, content: "other();" },
      {
        label: "S2",
        chunkId: 2,
        path: "b.ts",
        startLine: 1,
        endLine: 3,
        content: "if (a) {\n  run();\n}",
      },
    ];
    expect(citeCopiedCode("Look:\n\n```ts\nrun();\n```", sources)).toBe(
      "Look:\n\n```ts\nrun();\n```\n\nCopied from [S2].",
    );
  });
});

describe("issues and plans", () => {
  it("ranks clear newcomer invitations with little discussion first", () => {
    const now = Date.parse("2026-09-15T00:00:00Z");
    const ranked = rankNewcomerIssues(
      [
        issue(1, { labels: ["help wanted"], comments: 1 }),
        issue(2, { labels: ["good first issue"], comments: 25 }),
        issue(3, { labels: ["good first issue"], comments: 1 }),
      ],
      now,
    );
    expect(ranked.map((item) => item.number)).toEqual([3, 2, 1]);
  });

  it("finds newcomer labels, searches free issues and caches the answers", async () => {
    const requested: string[] = [];
    const fakeFetch = (async (url: string) => {
      requested.push(url);
      if (url.includes("/labels")) {
        return new Response(JSON.stringify([{ name: "bug" }, { name: "good first issue" }]));
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              number: 5,
              title: "Fix it",
              html_url: "https://github.com/acme/app/issues/5",
              labels: [{ name: "good first issue" }],
              comments: 0,
              reactions: { total_count: 1 },
              created_at: "2026-09-01T00:00:00Z",
              updated_at: "2026-09-10T00:00:00Z",
              body: "Details",
              state: "open",
            },
          ],
        }),
      );
    }) as typeof fetch;
    const client = createGithubIssues({ fetch: fakeFetch, now: () => Date.parse("2026-09-15") });
    const first = await client.newcomerIssues("acme/app");
    await client.newcomerIssues("acme/app");
    expect(first.map((item) => item.number)).toEqual([5]);
    expect(requested).toHaveLength(2);
    expect(decodeURIComponent(requested[1]!)).toContain(
      'repo:acme/app is:issue is:open no:assignee -linked:pr label:"good first issue"',
    );
  });

  it("routes questions by keywords when no model plans them", () => {
    expect(heuristicPlan("Can you explain issue #5508?")).toMatchObject({
      intent: "contribute",
      issue: 5508,
    });
    expect(heuristicPlan("I am a beginner, what is this repo about?")).toMatchObject({
      intent: "overview",
      level: "beginner",
    });
    expect(heuristicPlan("How are rows sorted?").intent).toBe("code");
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
