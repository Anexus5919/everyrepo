# kickstart

Working codename. A tool that explains any open-source repository: how its codebase is organized,
how contributions get merged, where a newcomer can start, and what changed recently.

## Requirements

- Node.js 22.12 or newer
- pnpm 10

## Setup

```sh
pnpm install
cp kickstart.local.example.json kickstart.local.json
```

Edit `kickstart.local.json` to point at a data directory and any local clones you already have.

## Commands

| Command                     | Purpose                                      |
| --------------------------- | -------------------------------------------- |
| `pnpm check`                | Format check, lint, typecheck and tests      |
| `pnpm kickstart repos list` | Show test repositories and their local state |
