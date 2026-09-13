export interface TestRepo {
  repo: string;
  reason: string;
}

// Repositories used to validate every pipeline stage across languages and sizes
export const testRepos: readonly TestRepo[] = [
  { repo: "mui/mui-x", reason: "Large TypeScript monorepo with licensed package tiers" },
  { repo: "jenkinsci/jenkins", reason: "Large Java project with Maven modules" },
  { repo: "toeverything/AFFiNE", reason: "TypeScript and Rust app monorepo on a canary branch" },
  { repo: "medusajs/medusa", reason: "Large TypeScript commerce monorepo" },
  { repo: "sugarlabs/www-v2", reason: "Community website project" },
  { repo: "accordproject/template-playground", reason: "Small TypeScript repository" },
];
