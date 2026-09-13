import { formatRepoRef, type RepoRef } from "@everyrepo/core";
import { eq } from "drizzle-orm";
import { orgs, repos } from "./app-schema.ts";
import type { AppDb } from "./open.ts";

export type RepoRow = typeof repos.$inferSelect;

// GitHub owner and repository names are case-insensitive, so keys are lowercase
export function ensureRepo(db: AppDb, ref: RepoRef): RepoRow {
  return db.transaction((tx) => {
    const orgKey = ref.owner.toLowerCase();
    tx.insert(orgs).values({ login: ref.owner, key: orgKey }).onConflictDoNothing().run();
    const org = tx.select().from(orgs).where(eq(orgs.key, orgKey)).get();
    if (!org) throw new Error(`Failed to register org ${ref.owner}`);

    const fullName = formatRepoRef(ref);
    const key = fullName.toLowerCase();
    tx.insert(repos)
      .values({ orgId: org.id, name: ref.name, fullName, key })
      .onConflictDoNothing()
      .run();
    const repo = tx.select().from(repos).where(eq(repos.key, key)).get();
    if (!repo) throw new Error(`Failed to register repository ${fullName}`);
    return repo;
  });
}

export function findRepo(db: AppDb, ref: RepoRef): RepoRow | undefined {
  return db
    .select()
    .from(repos)
    .where(eq(repos.key, formatRepoRef(ref).toLowerCase()))
    .get();
}
