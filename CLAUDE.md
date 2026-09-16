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
  - `eval [repos...] [--modes keyword,hybrid,files,rerank] [--dims <n>] [--details]` scores retrieval
    against the gold question sets in `packages/eval/gold`; `rerank` reorders the top files with the
    Workers AI reranker (`--rerank-top`, `--rerank-blend`). It lowered recall on the gold sets, so file
    ranking does not use it
  - `llm <task> <prompt...>` sends one prompt through the models configured for a task
  - `wiki <owner/repo> [--until <stage>]` generates wiki content for the indexed snapshot (stages:
    summarize, plan, write, glossary); a used-up model allowance pauses the job and a rerun resumes it
  - `export <owner/repo> [--out <dir>]` writes the generated pages as Markdown files for review
  - `site [--out <dir>]` writes the JSON the website is built from (`site` in dataDir by default) and
    marks the wikis it contains as published; a repository without written pages is listed only while a build for it
    is open
  - `ask <owner/repo> <question...> [--page <slug>]` answers a question with checked citations
  - `serve [--port <n>]` runs the Ask, account and repository request API on 127.0.0.1 (default port 8787) for
    the website; Ask is switched off when embeddings or models are not configured, requests keep working, and
    signing in is off until `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are set
  - `requests list|show|approve|decline|retry <owner/repo>` reviews repositories requested on the site;
    `approve` also adds a repository nobody asked for; `requests assign <owner/repo> <login>` links a request
    made before sign-in existed to the account of the person who made it
  - `worker [--once] [--poll <seconds>] [--no-build]` builds requested repositories in turn: reads the code,
    writes the wiki, exports the site data, builds the website and marks the wiki published; it only claims
    jobs that came from requests, so command line jobs are left alone. It reports a heartbeat every 15 seconds
    (`worker` table), and a job paused for a used-up allowance waits until the moment that allowance frees up
- `pnpm --filter @everyrepo/web dev` runs the website; it reads the site JSON from `EVERYREPO_SITE_DATA`
  or from `dataDir/site`, and calls the API at `PUBLIC_API_URL` (falling back to `PUBLIC_ASK_URL`, then the
  local `serve` address); `PUBLIC_TURNSTILE_SITE_KEY` turns on the person check before a request
- `pnpm --filter @everyrepo/db db:generate` regenerates SQL migrations after schema changes.

## Layout

- `packages/core`: shared vocabulary (size tiers, file and module kinds), repository references
  (`readRepoInput` reads owner/name and any GitHub web, clone or SSH address and says what is wrong with
  anything else), local config, test repository set, and the request shapes shared with the website
  (`@everyrepo/core/requests`: build stages with public labels, repository states, views)
- `packages/db`: Drizzle schemas and migrations for `app.sqlite` (registry, jobs) and per-snapshot
  engine databases (`engine/<owner>__<repo>/<sha>.sqlite`); re-exports drizzle query helpers so all
  packages share one instance
- `packages/queue`: SQLite job queue with ordered stages, heartbeats, retries and resume; jobs record an
  origin (command line or request), progress inside the running stage, and a time before which they are not
  claimed again: deferrals for a used-up allowance wait from 15 minutes doubling to 4 hours, crashes retry
  after a minute doubling to 30
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
- `packages/github`: GitHub REST client for repositories and file lists, with entity tag revalidation
  through a cache (`github_cache` in `app.sqlite`), one retry, and typed errors (not found, unavailable,
  empty, rate limited, unreachable); repository and owner search skip the cache and never return private
  repositories. `GITHUB_TOKEN` raises GitHub's search limit from 10 to 30 a minute
- `packages/requests`: repository requests. A lookup sizes a repository from GitHub's file list with the
  detector's own file classes (`estimateFromTree`) and rejects private, missing, empty and code-free
  repositories without storing them. Rules approve tiers up to `requests.autoApproveMaxTier` within
  `autoApprovePerDay` and `maxWaiting`; other requests wait for owner review. Every request belongs to a
  signed-in account (`user_request` keeps each account's history), and each account has one request in
  progress at a time until it is ready, failed or declined. Approved builds queue a read job, then
  a wiki job, then a publish job, smaller tiers first; repositories the owner adds with `requests approve` that nobody
  asked for wait behind every requested build, do not count toward `maxWaiting`, and move up once someone asks for
  them; `describeRecord` turns the registry, request and jobs
  into the state a status page shows. Ready times come from `simulateLine`, which plays the line forward for
  one worker against each model's rolling-day request limit and the embedding neuron budget (`capacity.ts`),
  with work taken from each engine database once read (`packages/cli/src/build-work.ts`) or sized from the
  file list before that; builds not yet requested or approved get a ready time as if they were.
  `createRepoSearch` suggests owners and repositories while someone types (`readSearchInput` in core decides
  what to search: an owner's repositories after a slash, otherwise names), orders names that start with the
  text first and then by stars, keeps answers for ten minutes, shares identical searches in flight and stops
  asking GitHub until a rate limit resets
- `packages/accounts`: GitHub sign-in. The authorization code flow with PKCE and a one-time state bound to the
  browser by a cookie (`auth_state`), the GitHub profile and primary verified email (`user`), and sessions kept
  as hashes of random tokens with a 30 day sliding expiry (`session`)
- `packages/eval`: gold question sets and retrieval metrics
- `packages/pipeline`: index stage handlers, cost estimate, snapshot report
- `packages/cli`: the `everyrepo` command, plus the local API. Ask streams one JSON object per line
  (stages, then the answer or an error). Requests are web Request and Response handlers
  (`src/request-api.ts`): `GET /api/repos/<owner>/<name>`, `GET /api/search?q=`, `POST /api/requests` and
  `GET /api/queue`, with
  entity tags for polling, rate limits per account and under daily salted hashes of addresses, and an optional
  Turnstile check. Accounts (`src/auth-api.ts`): `GET /api/auth/github` starts signing in and the callback sets
  an HttpOnly session cookie (`__Host-` prefixed over HTTPS) and returns to the page it started from;
  `GET /api/auth/me`, `POST /api/auth/signout`, `DELETE /api/account` and `GET /api/account/requests`.
  `EVERYREPO_SITE_URL` and `EVERYREPO_API_URL` name the two addresses. Calls that act for an account must come
  from local origins, the site or those in `EVERYREPO_ALLOWED_ORIGINS`, which are also the origins CORS allows
  with credentials
- `apps/web`: the Astro website, static pages built from the site JSON; styles are plain CSS with theme
  tokens in `src/styles/global.css` (dark by default, light on request). The home page snaps each section
  to the viewport and shows every written wiki (hero canvas, a reader preview with a tab per wiki, an Ask
  example and an import diagram taken from other wikis (`src/lib/showcase.ts`), features, repositories,
  audiences, method, common questions and the footer, which fills the screen below the header on desktop with its rows sharing the spare height and the wordmark centered at full size); header menus link every written wiki.
  The repository box (`src/components/RepoOpener.astro`, logic in `src/lib/opener.ts`, groups in
  `src/lib/suggestions.ts`) suggests written wikis, then GitHub repositories and owners as each letter is
  typed (picking an owner lists their repositories), turns a pasted link into owner/name, previews a
  repository once it is picked or typed exactly, and opens, requests or follows it; the header button opens the same box in a dialog (`RepoDialog.astro`). `/request/?repo=`
  follows one build through four steps, shows the estimated ready day, date and time with what it is made
  of, says when the builder is offline, and polls while something changes; `/queue/` lists builds, the line,
  requests in review and recent wikis with their ready times. A second request from the same person opens a
  window explaining the one request rule (`src/lib/notice.ts`). Requesting needs a GitHub sign-in: the header
  shows a sign-in link or the account menu (`src/lib/session.ts` asks the API once per page view), `/signin/`
  and `/signup/` say what GitHub shares before leaving for it and return to the page that sent people there
  (a request started while signed out carries on by itself after signing in), and `/account/` shows the
  profile, the account's requests with ready times, signing out and deleting the account. Each written wiki also gets a hub at `/<owner>/<repo>`, a reader page per wiki page at
  `/<owner>/<repo>/<slug>` (page tree, cited sources beside the text, import diagrams drawn from the stored
  flowcharts by `src/lib/diagram.ts`: cycle links drawn back, columns chosen for short links, median
  ordering with swaps to cut crossings, long links routed through lanes between boxes and bundled by
  target, link ends spread along each box; every diagram can be sent to the Ask panel to be explained) and a glossary; each page is also emitted as
  `/preview/<owner>__<repo>/<slug>.json` for the home preview. Hubs and reader pages open an Ask panel
  (`src/components/Ask.astro`, answer rendering in `src/lib/ask-render.ts`); reader pages keep a question box
  at the bottom of the article that opens it. First visits get a five step
  guide (`src/components/Guide.astro`); theme changes blur the whole page, then sweep the new
  colours in from the left (`src/lib/theme.ts`). Readers pick a colour palette separately from light and dark
  (header menu and footer select; `src/lib/palettes.ts`, tokens in `src/styles/palettes.css`, Ember's
  colours are the base tokens in `global.css`). Tide is the default and is labelled so; the page names a palette
  on `<html>` from the start and a reader's choice, kept in local storage, replaces it on every visit. Every palette keeps text, accents and code at readable contrast in both themes. Motion plays on hover or focus

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
