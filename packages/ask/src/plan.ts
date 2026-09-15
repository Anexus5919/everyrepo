import type { ChatMessage, LlmRouter } from "@everyrepo/llm";
import { z } from "zod";

export const PLAN_PROMPT_VERSION = "ask-plan-1";
export const ASK_INTENTS = ["code", "overview", "contribute", "general"] as const;
// A diagram explanation is chosen by the reader's button, never by the planner
export type AskIntent = (typeof ASK_INTENTS)[number] | "diagram";
export type ReaderLevel = "beginner" | "experienced" | "unknown";

export interface AskTurn {
  question: string;
  answer: string;
}

export interface PageContext {
  slug: string;
  title: string;
  purpose: string;
}

export interface AskPlan {
  intent: AskIntent;
  // The question rewritten to stand alone
  question: string;
  // Words and code names likely to appear in the relevant files
  search: string;
  level: ReaderLevel;
  issue: number | null;
  // False when the rules below decided instead of a model
  planned: boolean;
}

const planSchema = z.object({
  intent: z.enum(ASK_INTENTS),
  question: z.string().min(3).max(500),
  // Models sometimes list the search words instead of joining them
  search: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value.join(" ") : value).slice(0, 300)),
  level: z.enum(["beginner", "experienced", "unknown"]),
  issue: z.number().int().positive().nullable(),
});

const CONTRIBUTE =
  /good first|first issue|\bissues?\b|something to work on|what (?:can|should) i work on|help wanted|up for grabs/i;
const OVERVIEW =
  /what (?:is|does) (?:this|the|it)\b.*(?:repo|repository|project|library|package|about|do)|what is .+ about|\boverview\b|tech(?:nology)? stack|high.level|what can (?:it|this) do|purpose of (?:this|the) (?:repo|project)/i;
const BEGINNER = /beginner|new to|newbie|first time|junior|just started|learning|novice/i;
const ISSUE_NUMBER = /(?:#|issue\s+(?:number\s+)?)(\d{1,7})\b/i;

// Used when no model can plan: keyword rules cover the common cases
export function heuristicPlan(question: string): AskPlan {
  const issue = ISSUE_NUMBER.exec(question);
  const intent: AskIntent =
    issue || CONTRIBUTE.test(question)
      ? "contribute"
      : OVERVIEW.test(question)
        ? "overview"
        : "code";
  return {
    intent,
    question,
    search: question,
    level: BEGINNER.test(question) ? "beginner" : "unknown",
    issue: issue ? Number(issue[1]) : null,
    planned: false,
  };
}

export function planMessages(
  repo: string,
  summary: string | undefined,
  page: PageContext | undefined,
  history: readonly AskTurn[],
  question: string,
): ChatMessage[] {
  const earlier = history
    .map((turn) => `Reader: ${turn.question}\nAnswer: ${turn.answer}`)
    .join("\n\n");
  const user = [
    `Repository: ${repo}.${summary ? ` ${summary}` : ""}`,
    page
      ? `The reader is on the wiki page "${page.title}": ${page.purpose}`
      : "The reader is on the repository's main page.",
    earlier ? `Earlier in this conversation:\n${earlier}` : "",
    `New question: ${question}`,
    "",
    'Reply with a JSON object with the keys "intent", "question", "search", "level" and "issue":',
    '- intent "overview": what the project is or does, who it is for, its features, its high level architecture or technologies.',
    '- intent "code": how something in this repository works, where it is implemented, what a file, function or component does, or how to set it up, build, test, debug or contribute changes to it.',
    '- intent "contribute": finding an open GitHub issue to work on, or explaining a GitHub issue the reader names.',
    '- intent "general": anything that is not about this repository, such as general programming help.',
    "- question: the new question rewritten so it stands alone, resolving words such as it, this page or that file from the page and the conversation.",
    "- search: words and code names likely to appear in the source files that answer it.",
    '- level: "beginner" when the reader says they are new, "experienced" when they say they know the project well, otherwise "unknown".',
    "- issue: the issue number when the reader names one, otherwise null.",
  ]
    .filter((line) => line !== "")
    .join("\n");
  return [
    {
      role: "system",
      content:
        "You read questions typed into a chat box on a website that explains one GitHub repository and decide how they should be answered. Reply with JSON only.",
    },
    { role: "user", content: user },
  ];
}

// A model reads the question with its page and conversation; any failure falls back to the rules
export async function planQuestion(
  router: LlmRouter,
  input: {
    repo: string;
    summary: string | undefined;
    page: PageContext | undefined;
    history: readonly AskTurn[];
    question: string;
  },
): Promise<AskPlan> {
  const fallback = heuristicPlan(input.question);
  const task = router.hasTask("ask-plan") ? "ask-plan" : "ask";
  try {
    const { value } = await router.completeJson(
      task,
      {
        messages: planMessages(
          input.repo,
          input.summary,
          input.page,
          input.history,
          input.question,
        ),
        maxTokens: 400,
        temperature: 0,
      },
      planSchema,
      { promptVersion: PLAN_PROMPT_VERSION },
    );
    return {
      intent: value.intent,
      question: value.question.trim() || input.question,
      search: value.search.trim() || input.question,
      // A stated level in the question itself wins over a model that missed it
      level: fallback.level === "beginner" ? "beginner" : value.level,
      issue: value.issue ?? fallback.issue,
      planned: true,
    };
  } catch {
    return fallback;
  }
}
