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
  - `eval [repos...] [--modes keyword,vector,hybrid] [--dims <n>] [--details]` scores retrieval
    against the gold question sets in `packages/eval/gold`
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
- `packages/search`: FTS5 keyword, vector and hybrid (reciprocal rank fusion) search over chunks
- `packages/eval`: gold question sets and retrieval metrics
- `packages/pipeline`: index stage handlers, cost estimate, snapshot report
- `packages/cli`: the `everyrepo` command
- `apps/`: web app and worker, added later

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
