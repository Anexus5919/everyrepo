import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { AskInputError, type AskAnswer } from "@everyrepo/ask";
import { ModelUnavailableError } from "@everyrepo/llm";
import { afterEach, describe, expect, it } from "vitest";
import { createAskHandler, type AskBackend } from "./ask-server.ts";

const answer: AskAnswer = {
  status: "answered",
  question: "Where is the port read?",
  markdown:
    "It is read in `loadConfig` [[1]](https://github.com/acme/app/blob/abc/src/load.ts#L1-L4).",
  sources: [],
  files: [],
  pages: [],
  model: "fake",
  cached: false,
  checks: { written: 1, kept: 1, missingNames: [] },
};

let server: Server | undefined;

async function start(backend: AskBackend, perMinute = 10): Promise<string> {
  const handle = createAskHandler(backend, { perMinute });
  server = createServer((request, response) => void handle(request, response));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise((resolve) => server?.close(resolve));
  server = undefined;
});

const post = (base: string, body: unknown, origin = "http://localhost:4321") =>
  fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });

const lines = async (response: Response) =>
  (await response.text())
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("Ask API", () => {
  it("streams stages and then the answer to a local site", async () => {
    const base = await start({
      repos: () => [],
      ask: async (_repo, _question, onEvent) => {
        onEvent?.({ type: "searching" });
        onEvent?.({ type: "reading", files: ["src/load.ts"] });
        onEvent?.({ type: "writing" });
        return answer;
      },
    });
    const response = await post(base, { repo: "acme/app", question: "Where is the port read?" });
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    expect(await lines(response)).toEqual([
      { type: "stage", stage: "searching" },
      { type: "stage", stage: "reading", files: ["src/load.ts"] },
      { type: "stage", stage: "writing" },
      { type: "answer", answer },
    ]);
  });

  it("does not open answers to other sites", async () => {
    const base = await start({ repos: () => [], ask: async () => answer });
    const response = await post(
      base,
      { repo: "acme/app", question: "Where?" },
      "https://example.com",
    );
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("explains bad input and used up allowances without internal details", async () => {
    let calls = 0;
    const base = await start({
      repos: () => [],
      ask: async () => {
        calls += 1;
        if (calls === 1) throw new AskInputError("acme/other has not been read yet.");
        throw new ModelUnavailableError("groq-oss: daily request limit reached");
      },
    });
    expect((await post(base, { repo: "acme/app" })).status).toBe(400);
    expect(await lines(await post(base, { repo: "acme/other", question: "Why?" }))).toEqual([
      { type: "error", message: "acme/other has not been read yet." },
    ]);
    expect(await lines(await post(base, { repo: "acme/app", question: "Why?" }))).toEqual([
      { type: "error", message: "Ask has used its free allowance for now. Try again in a while." },
    ]);
  });

  it("limits how many questions one address asks per minute", async () => {
    const base = await start({ repos: () => [], ask: async () => answer }, 2);
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await post(base, { repo: "acme/app", question: "Where is it?" });
      statuses.push(response.status);
      await response.text();
    }
    expect(statuses).toEqual([200, 200, 429]);
  });
});
