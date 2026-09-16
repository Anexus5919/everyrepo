import type { AccountUser } from "@everyrepo/core";
import { and, authStates, eq, gt, lt, sessions, users, type AppDb } from "@everyrepo/db";
import type { GithubProfile } from "./github.ts";
import { randomToken, sha256Hex } from "./tokens.ts";

export type UserRow = typeof users.$inferSelect;

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
// A sign-in has ten minutes to come back from GitHub
export const SIGN_IN_WINDOW_MS = 10 * MINUTE_MS;
// Sessions last thirty days from the last visit
export const SESSION_MS = 30 * DAY_MS;
// Visits refresh a session at most once an hour, so reading pages does not write on every request
const REFRESH_MS = 60 * MINUTE_MS;

export function publicUser(user: UserRow): AccountUser {
  return {
    login: user.login,
    name: user.name,
    email: user.email,
    avatarUrl: user.avatarUrl,
    memberSince: user.createdAt.toISOString(),
  };
}

export async function beginSignIn(
  db: AppDb,
  input: { state: string; verifier: string; returnTo: string },
  now = new Date(),
): Promise<void> {
  db.delete(authStates)
    .where(lt(authStates.createdAt, new Date(now.getTime() - SIGN_IN_WINDOW_MS)))
    .run();
  db.insert(authStates)
    .values({
      stateHash: await sha256Hex(input.state),
      verifier: input.verifier,
      returnTo: input.returnTo,
      createdAt: now,
    })
    .run();
}

// A state is used once; an unknown or stale one means the sign-in did not start in this browser
export async function takeSignIn(
  db: AppDb,
  state: string,
  now = new Date(),
): Promise<{ verifier: string; returnTo: string } | undefined> {
  const stateHash = await sha256Hex(state);
  const row = db.select().from(authStates).where(eq(authStates.stateHash, stateHash)).get();
  if (!row) return undefined;
  db.delete(authStates).where(eq(authStates.stateHash, stateHash)).run();
  if (now.getTime() - row.createdAt.getTime() > SIGN_IN_WINDOW_MS) return undefined;
  return { verifier: row.verifier, returnTo: row.returnTo };
}

// The first sign-in creates the account; later ones refresh the name, email and avatar from GitHub
export function saveGithubUser(db: AppDb, profile: GithubProfile, now = new Date()): UserRow {
  const values = {
    login: profile.login,
    name: profile.name,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
    lastSeenAt: now,
  };
  return db
    .insert(users)
    .values({ githubId: profile.id, createdAt: now, ...values })
    .onConflictDoUpdate({ target: users.githubId, set: values })
    .returning()
    .get();
}

export async function createSession(
  db: AppDb,
  userId: number,
  now = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + SESSION_MS);
  db.insert(sessions)
    .values({
      tokenHash: await sha256Hex(token),
      userId,
      createdAt: now,
      expiresAt,
      lastSeenAt: now,
    })
    .run();
  return { token, expiresAt };
}

export type SessionRow = typeof sessions.$inferSelect;

export async function userForSession(
  db: AppDb,
  token: string | undefined,
  now = new Date(),
): Promise<UserRow | undefined> {
  return (await sessionForToken(db, token, now))?.user;
}

// The account and its session, whose start time tells how long ago the person signed in
export async function sessionForToken(
  db: AppDb,
  token: string | undefined,
  now = new Date(),
): Promise<{ user: UserRow; session: SessionRow } | undefined> {
  if (!token || token.length > 200) return undefined;
  const tokenHash = await sha256Hex(token);
  const row = db
    .select({ session: sessions, user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
    .get();
  if (!row) return undefined;
  if (now.getTime() - row.session.lastSeenAt.getTime() > REFRESH_MS) {
    db.update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_MS) })
      .where(eq(sessions.tokenHash, tokenHash))
      .run();
    db.update(users).set({ lastSeenAt: now }).where(eq(users.id, row.user.id)).run();
  }
  return row;
}

export async function endSession(db: AppDb, token: string | undefined): Promise<void> {
  if (!token) return;
  db.delete(sessions)
    .where(eq(sessions.tokenHash, await sha256Hex(token)))
    .run();
}

// Clears expired sessions and sign-ins that never came back from GitHub
export function pruneSessions(db: AppDb, now = new Date()): void {
  db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  const oldest = new Date(now.getTime() - SIGN_IN_WINDOW_MS);
  db.delete(authStates).where(lt(authStates.createdAt, oldest)).run();
}

// Removes the account, its sessions and its request history; the repositories and their wikis stay
export function deleteUser(db: AppDb, userId: number): void {
  db.delete(users).where(eq(users.id, userId)).run();
}
