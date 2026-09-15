import { Marked, type Tokens } from "marked";

export interface AskSource {
  number: number;
  kind: "code" | "issue" | "page" | "summary" | "diagram";
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  excerpt: string;
}

export interface IssueCard {
  number: number;
  title: string;
  url: string;
  labels: string[];
  comments: number;
  reactions: number;
  updatedAt: string;
}

export interface AskAnswer {
  status: "answered" | "not-found" | "off-topic";
  intent: "code" | "overview" | "contribute" | "general" | "diagram";
  question: string;
  markdown: string;
  note: string;
  sources: AskSource[];
  files: Array<{ path: string; url: string }>;
  pages: Array<{ slug: string; title: string }>;
  issue: IssueCard | null;
  otherIssues: IssueCard[];
  model: string;
  cached: boolean;
}

export interface AskDiagram {
  nodes: Array<{ id: number; label: string }>;
  edges: Array<{ from: number; to: number }>;
}

export type AskStreamLine =
  | { type: "stage"; stage: string; label: string; files?: string[] }
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

const GITHUB_LINK = /^https:\/\/github\.com\//;
const SITE_LINK = /^\/(?!\/)/;

// Answers are model text, so raw HTML is shown as text and only GitHub and site links stay clickable
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
      const site = SITE_LINK.test(token.href);
      if (!site && !GITHUB_LINK.test(token.href)) return this.parser.parseInline(token.tokens);
      const href = escapeHtml(token.href);
      const target = site ? "" : ' target="_blank" rel="noopener"';
      if (cite) {
        return `<a class="cite" href="${href}" data-cite="${cite[1]}"${target}>${cite[1]}</a>`;
      }
      return `<a href="${href}"${target}>${this.parser.parseInline(token.tokens)}</a>`;
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

// What an earlier answer said, without links or code, for the next question's context
export function plainAnswer(answer: Pick<AskAnswer, "markdown" | "note">): string {
  const text = answer.markdown || answer.note;
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[\[\d+\]\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 600);
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
