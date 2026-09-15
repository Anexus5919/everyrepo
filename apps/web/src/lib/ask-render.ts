import { Marked, type Tokens } from "marked";

export interface AskSource {
  number: number;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  excerpt: string;
}

export interface AskAnswer {
  status: "answered" | "not-found";
  question: string;
  markdown: string;
  sources: AskSource[];
  files: Array<{ path: string; url: string }>;
  pages: Array<{ slug: string; title: string }>;
  model: string;
  cached: boolean;
}

export type AskStreamLine =
  | { type: "stage"; stage: "searching" | "reading" | "writing"; files?: string[] }
  | { type: "answer"; answer: AskAnswer }
  | { type: "error"; message: string };

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SAFE_LINK = /^https:\/\/github\.com\//;

// Answers are model text, so raw HTML is shown as text and only GitHub links stay clickable
const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    image(token: Tokens.Image) {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link) {
      const cite = /^\[(\d+)\]$/.exec(token.text);
      if (!SAFE_LINK.test(token.href)) return this.parser.parseInline(token.tokens);
      const href = escapeHtml(token.href);
      if (cite) {
        return `<a class="cite" href="${href}" data-cite="${cite[1]}" target="_blank" rel="noopener">${cite[1]}</a>`;
      }
      return `<a href="${href}" target="_blank" rel="noopener">${this.parser.parseInline(token.tokens)}</a>`;
    },
    code(token: Tokens.Code) {
      return `<pre class="answer-code"><code>${escapeHtml(token.text)}</code></pre>`;
    },
  },
});

export function renderAnswer(markdown: string): string {
  const html = marked.parse(markdown, { async: false });
  return html.replace(
    /(?:<a class="cite"[^>]*>\d+<\/a>){2,}/g,
    (group) => `<span class="cite-group">${group}</span>`,
  );
}

// Lines of an excerpt with their line numbers, cut to a readable length
export function excerptLines(
  source: Pick<AskSource, "excerpt" | "startLine">,
  limit = 16,
): { lines: Array<{ number: number; text: string }>; more: number } {
  const all = source.excerpt.split("\n");
  return {
    lines: all.slice(0, limit).map((text, index) => ({ number: source.startLine + index, text })),
    more: Math.max(0, all.length - limit),
  };
}

// Splits a streamed body into complete JSON lines, keeping any partial line for the next read
export function takeLines(buffer: string): { lines: AskStreamLine[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  const lines = parts
    .filter((part) => part.trim() !== "")
    .map((part) => JSON.parse(part) as AskStreamLine);
  return { lines, rest };
}
