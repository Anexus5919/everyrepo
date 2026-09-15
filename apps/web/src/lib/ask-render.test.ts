import { describe, expect, it } from "vitest";
import { excerptLines, plainAnswer, renderAnswer, takeLines } from "./ask-render.ts";

const URL_ONE = "https://github.com/acme/app/blob/abc/src/load.ts#L1-L4";
const URL_TWO = "https://github.com/acme/app/blob/abc/src/run.ts#L8-L9";

describe("renderAnswer", () => {
  it("turns citation links into grouped chips", () => {
    const html = renderAnswer(`Reads \`PORT\` [[1]](${URL_ONE})[[2]](${URL_TWO}).`);
    expect(html).toContain("<code>PORT</code>");
    expect(html).toContain(
      `<span class="cite-group"><a class="cite" href="${URL_ONE}" data-cite="1" target="_blank" rel="noopener">1</a>`,
    );
  });

  it("shows raw HTML as text and drops links that do not go to GitHub", () => {
    const html = renderAnswer(
      'Hello <img src=x onerror="alert(1)"> [click](javascript:alert(1)) [site](https://example.com)',
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain('href="https://example.com"');
  });

  it("keeps wiki page citations on the site", () => {
    expect(renderAnswer("See the overview [[1]](/acme/app/overview).")).toContain(
      '<a class="cite" href="/acme/app/overview" data-cite="1">1</a>',
    );
    expect(renderAnswer("[x](//evil.example/path)")).not.toContain("href");
  });

  it("escapes code blocks", () => {
    expect(renderAnswer("```ts\nif (a < b) run();\n```")).toContain(
      '<pre class="answer-code"><code>if (a &lt; b) run();</code></pre>',
    );
  });
});

describe("stream helpers", () => {
  it("reduces an answer to plain text for follow-up questions", () => {
    expect(
      plainAnswer({
        markdown: "Uses **`loadConfig`** [[1]](https://github.com/a/b).\n\n```ts\nrun();\n```",
        note: "",
      }),
    ).toBe("Uses loadConfig .");
  });

  it("keeps a partial line for the next read", () => {
    const { lines, rest } = takeLines('{"type":"stage","stage":"searching"}\n{"type":"sta');
    expect(lines).toEqual([{ type: "stage", stage: "searching" }]);
    expect(rest).toBe('{"type":"sta');
  });

  it("numbers excerpt lines from the start line", () => {
    const { lines, more } = excerptLines({ excerpt: "a\nb\nc", startLine: 40 }, 2);
    expect(lines).toEqual([
      { number: 40, text: "a" },
      { number: 41, text: "b" },
    ]);
    expect(more).toBe(1);
  });
});
