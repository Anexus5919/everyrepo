// JSON the website is built from, written by the site command

export interface SiteCitation {
  number: number;
  path: string;
  startLine: number;
  endLine: number;
  url: string;
  excerpt: string;
}

export interface SiteReadingItem {
  path: string;
  role: string;
  url: string;
}

export interface SitePage {
  slug: string;
  parentSlug: string | null;
  title: string;
  purpose: string;
  status: string;
  section: boolean;
  markdown: string | null;
  citations: SiteCitation[];
  readingOrder: SiteReadingItem[];
}

export interface SiteRepo {
  repo: string;
  owner: string;
  name: string;
  status: "ready" | "queued" | "indexing";
  sha: string | null;
  branch: string | null;
  sizeTier: string | null;
  summary: string | null;
  files: number;
  sourceFiles: number;
  packages: number;
  languages: Array<{ language: string; files: number }>;
  pages: number;
  indexedAt: number | null;
}

export interface SiteGlossaryTerm {
  term: string;
  definition: string;
  url: string | null;
  path: string | null;
}

export interface SiteWiki extends SiteRepo {
  overview: string;
  architecture: string;
  technologies: string[];
  wikiPages: SitePage[];
  glossary: SiteGlossaryTerm[];
}
