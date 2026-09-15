import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { SiteRepo, SiteWiki } from "@everyrepo/core";

// The site command writes this folder; EVERYREPO_SITE_DATA overrides the local config
function siteDir(): string {
  if (process.env.EVERYREPO_SITE_DATA) return process.env.EVERYREPO_SITE_DATA;
  const configPath = resolve(process.cwd(), "../../everyrepo.local.json");
  if (!existsSync(configPath)) throw new Error("Set EVERYREPO_SITE_DATA to the site data folder");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as { dataDir: string };
  return join(config.dataDir, "site");
}

// Every page of the build reads the same files, so each is parsed once
const cache = new Map<string, unknown>();

function readJson<T>(name: string): T {
  const file = join(siteDir(), name);
  if (!cache.has(file)) cache.set(file, JSON.parse(readFileSync(file, "utf8")));
  return cache.get(file) as T;
}

export function loadRepos(): SiteRepo[] {
  return readJson<SiteRepo[]>("repos.json");
}

export function loadWiki(repo: string): SiteWiki {
  return readJson<SiteWiki>(`${repo.replace("/", "__")}.json`);
}
