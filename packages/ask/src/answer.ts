import type { EngineDb } from "@everyrepo/db";
import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import type { VectorIndex } from "@everyrepo/search";
import { githubLink, splitBlocks, verifyPage, type Source } from "@everyrepo/wiki";
import { IssueLookupError, type GithubIssue, type IssueSource } from "./issues.ts";
import { loadKnowledge, pageText, summaryText, type WikiPageInfo } from "./knowledge.ts";
import {
  planQuestion,
  type AskIntent,
  type AskPlan,
  type AskTurn,
  type PageContext,
} from "./plan.ts";
import { documentChunks, retrieveSources, type RetrieveOptions } from "./retrieve.ts";

export const ASK_PROMPT_VERSION = "ask-3";
export const QUESTION_LIMITS = { min: 3, max: 300 };

export type SourceKind = "code" | "issue" | "page" | "summary";

export interface AskSource {
  number: number;
  kind: SourceKind;
  title: string;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  excerpt: string;
}

export interface AskPage {
  slug: string;
  title: string;
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
  intent: AskIntent;
  question: string;
  markdown: string;
  // Shown in place of an answer text
  note: string;
  // Cited sources in the order their numbers appear
  sources: AskSource[];
  // Every file that was read for the answer
  files: Array<{ path: string; url: string }>;
  pages: AskPage[];
  issue: IssueCard | null;
  otherIssues: IssueCard[];
  model: string;
  cached: boolean;
  // Blocks the model wrote and blocks that survived the source checks
  checks: { written: number; kept: number; missingNames: string[] };
}

export type AskStage = "understanding" | "searching" | "issues" | "reading" | "writing";

export interface AskEvent {
  type: "stage";
  stage: AskStage;
  label: string;
  files?: string[];
}

export interface AskInput {
  engine: EngineDb;
  index: VectorIndex;
  router: LlmRouter;
  embedQuery: (text: string) => Promise<Float32Array>;
  repo: string;
  sha: string;
  question: string;
  // Slug of the wiki page the reader is on
  page?: string | null;
  // Earlier questions and answers in this conversation, oldest first
  history?: readonly AskTurn[];
  issues?: IssueSource;
  retrieve?: RetrieveOptions;
  onEvent?: (event: AskEvent) => void;
}

// The question itself is at fault, so callers can show the message as is
export class AskInputError extends Error {
  override readonly name = "AskInputError";
}

export interface ContextSource extends Source {
  kind: SourceKind;
  title: string;
  url: string;
}

const MAX_ANSWER_TOKENS = 1_800;
const NOT_FOUND = /^\s*NOT_FOUND\b/;
const HISTORY_TURNS = 3;
const HISTORY_ANSWER_CHARS = 600;
const CONTRIBUTING = [{ like: "contributing%", root: true }, { like: "%/contributing%" }];
const README = [{ like: "readme%", root: true }];

export function cleanQuestion(text: string): string {
  const question = text.replace(/\s+/g, " ").trim();
  if (question.length < QUESTION_LIMITS.min) throw new AskInputError("Write a longer question.");
  if (question.length > QUESTION_LIMITS.max) {
    throw new AskInputError(`Keep the question under ${QUESTION_LIMITS.max} characters.`);
  }
  return question;
}

// Recent turns only, with links and code removed, so follow-ups stay cheap to plan
export function cleanHistory(history: readonly AskTurn[]): AskTurn[] {
  return history.slice(-HISTORY_TURNS).map((turn) => ({
    question: turn.question.replace(/\s+/g, " ").trim().slice(0, QUESTION_LIMITS.max),
    answer: turn.answer
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/\[\[(\d+)\]\]\([^)]*\)/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, HISTORY_ANSWER_CHARS),
  }));
}

// Models sometimes write typographic hyphens inside names or cite right after a closing code fence
export function normalizeAnswer(text: string): string {
  return text
    .replace(/[\u2010\u2011]/g, "-")
    .replace(/^([ \t]*```)[ \t]*(\[S\d+(?:\s*,\s*S\d+)*\])[ \t]*$/gm, "$1\n\nCopied from $2.");
}

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

// A code block copied from a source gets a citation line so readers can open where it came from
export function citeCopiedCode(text: string, sources: readonly Source[]): string {
  const lines = text.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    output.push(line);
    if (!/^\s*```\S*\s*$/.test(line)) continue;
    const body: string[] = [];
    let end = index + 1;
    while (end < lines.length && !/^\s*```\s*$/.test(lines[end]!)) body.push(lines[end++]!);
    output.push(...body);
    if (end < lines.length) output.push(lines[end]!);
    index = end;
    const next = lines.slice(end + 1).find((candidate) => candidate.trim() !== "");
    if (next && /^\s*(?:Copied from )?\[S\d+/.test(next)) continue;
    const wanted = body.map(collapse).filter(Boolean);
    const source = wanted.length
      ? sources.find((candidate) => {
          const content = collapse(candidate.content);
          return wanted.every((item) => content.includes(item));
        })
      : undefined;
    if (source) output.push("", `Copied from [${source.label}].`);
  }
  return output.join("\n");
}

export function fileUrl(repo: string, sha: string, path: string): string {
  return `https://github.com/${repo}/blob/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Written wiki pages that cover the cited files first, then the files that were read
export function relatedPages(
  pages: readonly WikiPageInfo[],
  cited: readonly string[],
  read: readonly string[],
  limit = 3,
): AskPage[] {
  const citedSet = new Set(cited);
  const readSet = new Set(read);
  return pages
    .filter((page) => page.status === "written")
    .map((page, position) => ({
      slug: page.slug,
      title: page.title,
      position,
      score: page.files.reduce(
        (sum, path) => sum + (citedSet.has(path) ? 2 : readSet.has(path) ? 1 : 0),
        0,
      ),
    }))
    .filter((page) => page.score > 0)
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .slice(0, limit)
    .map(({ slug, title }) => ({ slug, title }));
}

const issueCard = (issue: GithubIssue): IssueCard => ({
  number: issue.number,
  title: issue.title,
  url: issue.url,
  labels: issue.labels,
  comments: issue.comments,
  reactions: issue.reactions,
  updatedAt: issue.updatedAt,
});

// Template comments and images carry nothing a reader needs
export function issueText(issue: GithubIssue, maxChars: number): string {
  const body = issue.body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/<img[^>]*>/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const facts = [
    `State: ${issue.open ? "open" : "closed"}.`,
    `Labels: ${issue.labels.join(", ") || "none"}.`,
    `Comments: ${issue.comments}. Reactions: ${issue.reactions}.`,
    `Opened ${issue.createdAt.slice(0, 10)}, last updated ${issue.updatedAt.slice(0, 10)}.`,
  ].join(" ");
  return `Issue #${issue.number}: ${issue.title}\n${facts}\n\n${body.slice(0, maxChars)}`;
}

// Code keeps its path and lines; issues, pages and the overview are named so the model can refer to them
export function formatAskSources(sources: readonly ContextSource[]): string {
  const fence = "`".repeat(3);
  return sources
    .map((source) => {
      if (source.kind === "code") {
        return [
          `[${source.label}] ${source.path} (lines ${source.startLine}-${source.endLine})`,
          fence,
          source.content,
          fence,
        ].join("\n");
      }
      const kind = { issue: "GitHub issue", page: "wiki page", summary: "wiki" }[source.kind];
      return `[${source.label}] ${source.title} (${kind})\n${source.content}`;
    })
    .join("\n\n");
}

function answerMessages(
  repo: string,
  summary: string | undefined,
  plan: AskPlan,
  page: PageContext | undefined,
  history: readonly AskTurn[],
  sources: readonly ContextSource[],
  issue: GithubIssue | null,
): ChatMessage[] {
  const system = [
    `You answer questions in a chat box on a website that explains the GitHub repository ${repo} to developers.`,
    "Use only the numbered sources. Every paragraph and every list item must end with citations such as [S2] or [S1, S3] that name the sources supporting it.",
    "Put names in backticks only when they appear exactly in the cited sources.",
    "If the sources do not show the answer, reply with exactly NOT_FOUND and nothing else.",
    "Write plain, specific English without headings. Do not use long dashes, emoji or marketing words.",
  ].join(" ");

  const instructions: Record<AskIntent, string[]> = {
    code: [
      "- Start with the direct answer in one or two sentences, then explain how it works in the code: which functions run, what they read or change, and in which order.",
      "- Keep it between 80 and 280 words.",
      "- Add a short code excerpt only when it makes the answer clearer, copied exactly from a source.",
    ],
    overview: [
      "- Explain what the project is and who it is for, then its main parts and how they fit together, then where a newcomer could start reading.",
      "- Keep it between 100 and 260 words. A short list of the main parts is fine.",
    ],
    contribute: [
      `- Source S1 is GitHub issue #${issue?.number ?? 0}. Recommend it and explain these four things in order, each in its own short paragraph:`,
      "  what the issue asks for or what is broken, in plain words;",
      "  how serious it is and who it affects, judged from its labels, reactions, comments and description, saying that this is an estimate;",
      "  which files are likely to change and why, citing the code sources, saying these are likely places to look rather than a confirmed fix;",
      "  first steps to start, taken from the contributing guide when it is among the sources, written as plain actions without naming code.",
      "- Keep it between 150 and 350 words.",
    ],
    general: [],
  };

  const earlier = history
    .map((turn) => `Reader: ${turn.question}\nAnswer: ${turn.answer}`)
    .join("\n\n");
  const user = [
    `Repository: ${repo}.${summary ? ` ${summary}` : ""}`,
    page ? `The reader is on the wiki page "${page.title}": ${page.purpose}` : null,
    plan.level === "beginner"
      ? "The reader says they are new, so explain terms briefly and keep each step concrete."
      : null,
    earlier ? `Earlier in this conversation:\n${earlier}` : null,
    "",
    "Numbered sources:",
    formatAskSources(sources),
    "",
    `Question: ${plan.question}`,
    "",
    "Instructions:",
    ...instructions[plan.intent],
    "- End every paragraph and list item with citations like [S3].",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

const pageSource = (repo: string, page: WikiPageInfo, maxChars: number): ContextSource => ({
  label: "",
  chunkId: 0,
  kind: "page",
  title: page.title,
  path: `wiki/${page.slug}`,
  startLine: 0,
  endLine: 0,
  content: pageText(page.markdown ?? "", maxChars),
  url: `/${repo}/${page.slug}`,
});

export async function askQuestion(input: AskInput): Promise<AskAnswer> {
  const { engine, repo, sha } = input;
  const question = cleanQuestion(input.question);
  const history = cleanHistory(input.history ?? []);
  const knowledge = loadKnowledge(engine.$client);
  const pageInfo = input.page
    ? knowledge.pages.find((page) => page.slug === input.page)
    : undefined;
  const page = pageInfo
    ? { slug: pageInfo.slug, title: pageInfo.title, purpose: pageInfo.purpose }
    : undefined;
  const emit = (stage: AskStage, label: string, files?: string[]) =>
    input.onEvent?.({ type: "stage", stage, label, ...(files ? { files } : {}) });

  emit("understanding", "Understanding the question");
  const plan = await planQuestion(input.router, {
    repo,
    summary: knowledge.summary,
    page,
    history,
    question,
  });

  const answer: AskAnswer = {
    status: "not-found",
    intent: plan.intent,
    question,
    markdown: "",
    note: "",
    sources: [],
    files: [],
    pages: [],
    issue: null,
    otherIssues: [],
    model: "",
    cached: false,
    checks: { written: 0, kept: 0, missingNames: [] },
  };

  if (plan.intent === "general") {
    return {
      ...answer,
      status: "off-topic",
      note: `This chat answers questions about ${repo}: how its code works, what its wiki covers and how to contribute to it.`,
    };
  }

  const codeSource = (source: Source): ContextSource => ({
    ...source,
    kind: "code",
    title: source.path,
    url: githubLink(repo, sha, source),
  });
  const context: ContextSource[] = [];
  let code: ContextSource[];
  let issue: GithubIssue | null = null;

  if (plan.intent === "contribute") {
    if (!input.issues) return { ...answer, note: "Issues cannot be looked up here." };
    emit(
      "issues",
      plan.issue ? `Opening issue #${plan.issue}` : "Looking for open issues marked for newcomers",
    );
    try {
      if (plan.issue) {
        issue = await input.issues.issue(repo, plan.issue);
      } else {
        const found = await input.issues.newcomerIssues(repo);
        issue = found[0] ?? null;
        answer.otherIssues = found.slice(1, 4).map(issueCard);
      }
    } catch (error) {
      if (!(error instanceof IssueLookupError)) throw error;
      return { ...answer, note: `${error.message} Try again in a few minutes.` };
    }
    if (!issue) {
      return {
        ...answer,
        note: plan.issue
          ? `Issue #${plan.issue} was not found in ${repo}.`
          : `No open issues in ${repo} are marked for newcomers and free to take right now.`,
      };
    }
    answer.issue = issueCard(issue);
    context.push({
      label: "",
      chunkId: 0,
      kind: "issue",
      title: `#${issue.number} ${issue.title}`,
      path: `issues/${issue.number}`,
      startLine: 0,
      endLine: 0,
      content: issueText(issue, 3_000),
      url: issue.url,
    });
    const issueQuery = `${issue.title}\n${issue.body.replace(/<!--[\s\S]*?-->/g, "").slice(0, 600)}`;
    const vector = await input.embedQuery(issueQuery.slice(0, 1_000));
    code = [
      ...documentChunks(engine, CONTRIBUTING, 2_500),
      ...retrieveSources(engine, input.index, issueQuery, vector, { maxChars: 9_000 }),
    ].map(codeSource);
  } else if (plan.intent === "overview") {
    emit("reading", "Reading the wiki and the README");
    const summary = summaryText(knowledge);
    if (summary) {
      context.push({
        label: "",
        chunkId: 0,
        kind: "summary",
        title: "Repository overview",
        path: "wiki",
        startLine: 0,
        endLine: 0,
        content: summary.slice(0, 5_000),
        url: `/${repo}`,
      });
    }
    const overviewPage = knowledge.pages.find(
      (candidate) => candidate.slug === "overview" && candidate.status === "written",
    );
    if (overviewPage?.markdown) context.push(pageSource(repo, overviewPage, 4_000));
    code = documentChunks(engine, README, 4_000).map(codeSource);
  } else {
    emit("searching", "Searching the code");
    if (pageInfo?.status === "written" && pageInfo.markdown) {
      context.push(pageSource(repo, pageInfo, 1_800));
    }
    const vector = await input.embedQuery(plan.question);
    code = retrieveSources(engine, input.index, `${plan.question} ${plan.search}`, vector, {
      maxChars: context.length > 0 ? 14_000 : 16_000,
      ...input.retrieve,
    }).map(codeSource);
  }

  const sources = [...context, ...code].map((source, index) => ({
    ...source,
    label: `S${index + 1}`,
  }));
  const paths = [...new Set(code.map((source) => source.path))];
  answer.files = paths.map((path) => ({ path, url: fileUrl(repo, sha, path) }));
  answer.pages = relatedPages(knowledge.pages, [], paths);
  if (sources.length === 0) {
    return { ...answer, note: "Nothing in the indexed code matched this question." };
  }
  if (plan.intent === "contribute") {
    emit("reading", `Reading issue #${issue!.number} and ${paths.length} files`, paths);
  } else if (plan.intent === "code") {
    emit("reading", `Reading ${paths.length} ${paths.length === 1 ? "file" : "files"}`, paths);
  }

  emit("writing", "Writing the answer");
  const result = await input.router.complete(
    "ask",
    {
      messages: answerMessages(repo, knowledge.summary, plan, page, history, sources, issue),
      maxTokens: MAX_ANSWER_TOKENS,
      temperature: 0.2,
    },
    { promptVersion: ASK_PROMPT_VERSION },
  );
  answer.model = result.model;
  answer.cached = result.cached;
  const missing = {
    ...answer,
    note: "The sources that were read do not answer this. Naming a feature, file or function usually helps.",
  };
  if (NOT_FOUND.test(result.text)) return missing;

  const byLabel = new Map(sources.map((source) => [source.label, source]));
  const verified = verifyPage(
    citeCopiedCode(normalizeAnswer(result.text), sources),
    sources,
    (source) => byLabel.get(source.label)?.url ?? githubLink(repo, sha, source),
    [repo, repo.split("/")[1] ?? repo, ...(issue ? [`#${issue.number}`] : [])],
  );
  answer.checks = {
    written: verified.stats.blocks,
    kept: verified.stats.kept,
    missingNames: verified.stats.missingNames,
  };
  // Code alone, with no explanation that survived the checks, does not count as an answer
  if (!splitBlocks(verified.markdown).some((block) => block.type === "text")) {
    return { ...missing, checks: answer.checks };
  }

  answer.status = "answered";
  answer.markdown = verified.markdown;
  answer.sources = verified.citations.map((citation) => {
    const source = byLabel.get(citation.label)!;
    return {
      number: citation.number,
      kind: source.kind,
      title: source.title,
      path: source.kind === "code" ? source.path : "",
      startLine: source.startLine,
      endLine: source.endLine,
      url: source.url,
      excerpt: source.content,
    };
  });
  answer.pages = relatedPages(
    knowledge.pages,
    answer.sources.filter((source) => source.kind === "code").map((source) => source.path),
    paths,
  );
  return answer;
}
