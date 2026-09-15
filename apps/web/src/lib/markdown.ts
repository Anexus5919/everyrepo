import { Marked, type Tokens } from "marked";
import { codeToHtml, createCssVariablesTheme } from "shiki";
import { renderDiagram } from "./diagram.ts";

const theme = createCssVariablesTheme({ name: "everyrepo", variablePrefix: "--code-" });

export async function highlight(code: string, language: string): Promise<string> {
  try {
    return await codeToHtml(code, { lang: language || "text", theme });
  } catch {
    return await codeToHtml(code, { lang: "text", theme });
  }
}

type CodeToken = Tokens.Code & { html?: string };

export interface RenderOptions {
  // Draw stored import diagrams instead of leaving them out
  diagrams?: boolean;
}

// Citation links arrive as [[n]](url) and render as numbered chips
export async function renderMarkdown(
  markdown: string,
  options: RenderOptions = {},
): Promise<string> {
  const marked = new Marked({ async: true, gfm: true });
  marked.use({
    async: true,
    async walkTokens(token) {
      if (token.type === "code" && token.lang !== "mermaid") {
        const code = token as CodeToken;
        code.html = await highlight(code.text, code.lang ?? "text");
      }
    },
    renderer: {
      link(token) {
        const match = /^\[(\d+)\]$/.exec(token.text);
        if (!match) return false;
        return `<a class="cite" href="${token.href}" data-cite="${match[1]}" target="_blank" rel="noopener">${match[1]}</a>`;
      },
      code(token) {
        const code = token as CodeToken;
        if (code.lang === "mermaid")
          return options.diagrams ? (renderDiagram(code.text) ?? "") : "";
        return `<div class="code-block">${code.html ?? ""}</div>`;
      },
    },
  });
  const html = await marked.parse(markdown);
  // Neighbouring citations read as one compact group
  return html.replace(
    /(?:<a class="cite"[^>]*>\d+<\/a>){2,}/g,
    (group) => `<span class="cite-group">${group}</span>`,
  );
}

// Splits page markdown into its opening paragraphs and its ## sections
export function sections(markdown: string): Array<{ heading: string | null; body: string }> {
  const parts: Array<{ heading: string | null; body: string }> = [{ heading: null, body: "" }];
  for (const block of markdown.split(/\n{2,}/)) {
    const heading = /^##\s+(.+)$/.exec(block.trim());
    if (heading) parts.push({ heading: heading[1]!, body: "" });
    else parts[parts.length - 1]!.body += `${block}\n\n`;
  }
  return parts;
}

export interface TocEntry {
  id: string;
  text: string;
}

// Gives each second level heading an id so the page can link to it
export function withHeadingIds(html: string): { html: string; toc: TocEntry[] } {
  const toc: TocEntry[] = [];
  const used = new Map<string, number>();
  const result = html.replace(/<h2>([\s\S]*?)<\/h2>/g, (_match, inner: string) => {
    const text = inner
      .replace(/<[^>]+>/g, "")
      .replace(/&amp;/g, "&")
      .trim();
    const base =
      text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "section";
    const seen = used.get(base) ?? 0;
    used.set(base, seen + 1);
    const id = seen === 0 ? base : `${base}-${seen + 1}`;
    toc.push({ id, text });
    return `<h2 id="${id}">${inner}</h2>`;
  });
  return { html: result, toc };
}
