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

export function loadRepos(): SiteRepo[] {
  return JSON.parse(readFileSync(join(siteDir(), "repos.json"), "utf8")) as SiteRepo[];
}

export function loadWiki(repo: string): SiteWiki {
  const file = join(siteDir(), `${repo.replace("/", "__")}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as SiteWiki;
}
