# CLAUDE.md

Guidance for working in this repository.

## Project

EveryRepo (everyrepo.me). The tool explains any public
GitHub repository: a generated codebase wiki with verified source citations, an Ask box, and
contribution guidance built from the repository's real activity.

## Stack

TypeScript (strict, ESM, NodeNext) in a pnpm workspace. Internal packages in `packages/` export
TypeScript source directly and run with tsx. Tests use Vitest.

## Commands

- `pnpm install`
- `pnpm check` runs format check, lint, typecheck and tests. Run it before every commit.
- `pnpm everyrepo <command>` runs the CLI:
  - `repos list` shows the test repositories and their upstream heads
  - `db migrate` creates or upgrades `app.sqlite` in `dataDir`
  - `index <owner/repo> [--until <stage>] [--no-fetch]` runs or resumes the index job
    (stages: source, detect, parse, graph, chunk, embed, estimate); embed is skipped when
    `embeddings` is not configured
  - `report <owner/repo> [--json]` summarizes the latest snapshot
  - `search <owner/repo> <query...> [--limit <n>]` runs keyword search over indexed chunks
  - `eval [repos...] [--modes keyword,hybrid,files] [--dims <n>] [--details]` scores retrieval
    against the gold question sets in `packages/eval/gold`
  - `llm <task> <prompt...>` sends one prompt through the models configured for a task
  - `wiki <owner/repo> [--until <stage>]` generates wiki content for the indexed snapshot (stages:
    summarize, plan, write, glossary); a used-up model allowance pauses the job and a rerun resumes it
  - `export <owner/repo> [--out <dir>]` writes the generated pages as Markdown files for review
  - `site [--out <dir>]` writes the JSON the website is built from (`site` in dataDir by default)
  - `ask <owner/repo> <question...> [--page <slug>]` answers a question with checked citations
  - `serve [--port <n>]` runs the Ask API on 127.0.0.1 (default port 8787) for the website
- `pnpm --filter @everyrepo/web dev` runs the website; it reads the site JSON from `EVERYREPO_SITE_DATA`
  or from `dataDir/site`, and its Ask panel calls `PUBLIC_ASK_URL` (the local `serve` address by default)
- `pnpm --filter @everyrepo/db db:generate` regenerates SQL migrations after schema changes.

## Layout

- `packages/core`: shared vocabulary (size tiers, file and module kinds), repository references,
  local config, test repository set
- `packages/db`: Drizzle schemas and migrations for `app.sqlite` (registry, jobs) and per-snapshot
  engine databases (`engine/<owner>__<repo>/<sha>.sqlite`); re-exports drizzle query helpers so all
  packages share one instance
- `packages/queue`: SQLite job queue with ordered stages, heartbeats, retries and resume
- `packages/repo`: resolves a repository's upstream commit and reads trees and blobs straight from
  git objects without a checkout
- `packages/detect`: languages, file kinds, modules (npm, pnpm, Maven, Gradle, Cargo, Go, Python),
  licenses, docs sources, size tier
- `packages/parse`: tree-sitter parsing with tags queries for TypeScript, TSX, JavaScript, Java,
  Rust, Python and Go, plus import extraction
- `packages/graph`: import resolution (JS/TS, Java, Python, Go, Rust), reference and co-change
  edges, PageRank and size-balanced file clusters
- `packages/chunk`: syntax-aware code chunks, markdown sections, identifier terms
- `packages/embed`: embedding providers (Cloudflare Workers AI by default, an optional local server
  exposing /v1/embeddings, a hashing embedder for tests) and vector helpers; vectors are cached per
  repository by content hash, and Workers AI usage is counted in hourly buckets against
  `dailyNeuronBudget` over a rolling 24 hours, pausing the job when it is used up
- `packages/search`: FTS5 keyword, vector and hybrid (reciprocal rank fusion) search over chunks,
  plus file ranking with a centrality prior and import expansion
- `packages/llm`: chat models behind one OpenAI-compatible client (Gemini, Groq, Workers AI), per
  task fallback order from the `llm` config, per-minute pacing, daily request limits, a response
  cache and JSON answers validated with zod
- `packages/wiki`: cluster, package and repository summaries, the page planner with plan repair, and
  the page writer. Every paragraph must cite numbered source chunks; the verifier drops uncited
  blocks, names missing from the cited sources and code not copied from them, then links citations
  to commit-pinned GitHub lines. Diagrams come from the import graph. Results are stored in the
  engine database and reused while inputs are unchanged; generated text passes through `plainText`
- `packages/ask`: answers questions about a repository. A planning call (the `ask-plan` task, falling back
  to `ask`, then to keyword rules) reads the question with the reader's page and recent turns, rewrites it
  to stand alone and picks an intent: code (hybrid retrieval plus the current page), overview (repository
  summary, overview page and README), contribute (open GitHub issues labeled for newcomers or a named
  issue, the contributing guide and the code the issue touches) or general (declined without an answer
  call). A diagram sent from a page skips planning and is explained from its boxes, arrows and the
  opening code of each box. One answer call follows; the wiki verifier drops uncited or ungrounded blocks and links
  citations to pinned lines, issues or wiki pages
- `packages/eval`: gold question sets and retrieval metrics
- `packages/pipeline`: index stage handlers, cost estimate, snapshot report
- `packages/cli`: the `everyrepo` command, plus the local Ask API (streams one JSON object per line:
  stages, then the answer or an error; local origins only, per address rate limit)
- `apps/web`: the Astro website, static pages built from the site JSON; styles are plain CSS with theme
  tokens in `src/styles/global.css` (dark by default, light on request). The home page snaps each section
  to the viewport and shows every written wiki (hero canvas, a reader preview with a tab per wiki, the
  footer wordmark). Each written wiki also gets a hub at `/<owner>/<repo>`, a reader page per wiki page at
  `/<owner>/<repo>/<slug>` (page tree, cited sources beside the text, import diagrams drawn from the stored
  flowcharts by `src/lib/diagram.ts`: cycle links drawn back, columns chosen for short links, median
  ordering with swaps to cut crossings, long links routed through lanes between boxes and bundled by
  target, link ends spread along each box; every diagram can be sent to the Ask panel to be explained) and a glossary; each page is also emitted as
  `/preview/<owner>__<repo>/<slug>.json` for the home preview. Hubs and reader pages open an Ask panel
  (`src/components/Ask.astro`, answer rendering in `src/lib/ask-render.ts`); reader pages keep a question box
  at the bottom of the article that opens it. First visits get a five step
  guide (`src/components/Guide.astro`); theme changes spread from the control that was used
  (`src/lib/theme.ts`). Motion plays on hover or focus

## Rules

- Do not name other products or projects as references or inspiration anywhere: code, comments,
  tests, fixtures, prompts, UI copy, docs, commit messages or PR descriptions.
- No em-dashes, no emojis, no decorative or boilerplate text. Plain, concise wording.
- Comments are single-line and only where the code is not self-explanatory.
- Commit messages are a short imperative title with no trailers and no tool attribution.
- Never change branches, files or stashes in the local clones listed in `everyrepo.local.json`.
  Only read from them or fetch into them. Derived copies go under `dataDir`.
- Machine-specific paths and secrets live in `everyrepo.local.json` and `.env`, both gitignored.
  `.env.example` lists the variable names. Never print, log or commit token values.
