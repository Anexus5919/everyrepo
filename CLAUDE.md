# CLAUDE.md

Guidance for working in this repository.

## Project

Working codename `kickstart`; the final product name is not chosen. The tool explains any public
GitHub repository: a generated codebase wiki with verified source citations, an Ask box, and
contribution guidance built from the repository's real activity.

## Stack

TypeScript (strict, ESM, NodeNext) in a pnpm workspace. Internal packages in `packages/` export
TypeScript source directly and run with tsx. Tests use Vitest.

## Commands

- `pnpm install`
- `pnpm check` runs format check, lint, typecheck and tests. Run it before every commit.
- `pnpm kickstart <command>` runs the CLI.

## Layout

- `packages/core`: repository references, local config, test repository set
- `packages/cli`: the `kickstart` command
- `apps/`: web app and worker, added later

## Rules

- Do not name other products or projects as references or inspiration anywhere: code, comments,
  tests, fixtures, prompts, UI copy, docs, commit messages or PR descriptions.
- No em-dashes, no emojis, no decorative or boilerplate text. Plain, concise wording.
- Comments are single-line and only where the code is not self-explanatory.
- Commit messages are a short imperative title with no trailers and no tool attribution.
- Never change branches, files or stashes in the local clones listed in `kickstart.local.json`.
  Only read from them or fetch into them. Derived copies go under `dataDir`.
- Machine-specific paths and secrets live in `kickstart.local.json` and `.env`, both gitignored.
