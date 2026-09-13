import type { RepoRef } from "@kickstart/core";
import { formatRepoRef } from "@kickstart/core";
import { eq, files, modules, snapshots, symbolRefs, symbols, type EngineDb } from "@kickstart/db";
import type { Detection } from "@kickstart/detect";
import type { ParseResult } from "@kickstart/parse";

export const ENGINE_VERSION = "0.1.0";
const INSERT_CHUNK = 500;

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    out.push(items.slice(index, index + size));
  return out;
}

export interface SnapshotInfo {
  ref: RepoRef;
  sha: string;
  remoteRef: string;
}

// Replaces everything in the engine database with a fresh detection result
export function writeDetection(engine: EngineDb, info: SnapshotInfo, detection: Detection): void {
  engine.transaction((tx) => {
    tx.delete(symbolRefs).run();
    tx.delete(symbols).run();
    tx.delete(files).run();
    tx.delete(modules).run();
    tx.delete(snapshots).run();

    tx.insert(snapshots)
      .values({
        sha: info.sha,
        repo: formatRepoRef(info.ref),
        ref: info.remoteRef,
        engineVersion: ENGINE_VERSION,
        sizeTier: detection.sizeTier,
        sourceTokens: detection.sourceTokens,
        stats: {
          kinds: detection.kinds,
          languages: detection.languages,
          docsSources: detection.docsSources,
        },
      })
      .run();

    const moduleIds = new Map<string, number>();
    for (const module of detection.modules) {
      const row = tx
        .insert(modules)
        .values({
          name: module.name,
          path: module.path,
          kind: module.kind,
          license: module.license ?? null,
        })
        .returning({ id: modules.id })
        .get();
      moduleIds.set(module.path, row.id);
    }
    const byDepth = [...detection.modules].sort((a, b) => b.path.length - a.path.length);
    for (const module of detection.modules) {
      if (module.path === "") continue;
      const parent = byDepth.find(
        (candidate) =>
          candidate.path !== module.path &&
          (candidate.path === "" || module.path.startsWith(`${candidate.path}/`)),
      );
      const id = moduleIds.get(module.path);
      if (parent && id !== undefined) {
        tx.update(modules)
          .set({ parentId: moduleIds.get(parent.path) ?? null })
          .where(eq(modules.id, id))
          .run();
      }
    }

    for (const batch of chunks(detection.files, INSERT_CHUNK)) {
      tx.insert(files)
        .values(
          batch.map((file) => ({
            path: file.path,
            oid: file.oid,
            bytes: file.bytes,
            tokens: file.tokens,
            language: file.language ?? null,
            kind: file.kind,
            moduleId: moduleIds.get(file.modulePath) ?? null,
          })),
        )
        .run();
    }
  });
}

export type ParseStatus = "ok" | "partial" | "failed" | "skipped";

export interface ParsedFile {
  fileId: number;
  status: ParseStatus;
  result?: ParseResult;
}

export function createParseWriter(engine: EngineDb) {
  const client = engine.$client;
  const insertSymbol = client.prepare(
    "INSERT INTO symbol (file_id, name, kind, exported, start_line, end_line, signature, doc) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const insertRef = client.prepare(
    "INSERT INTO symbol_ref (file_id, name, kind, line) VALUES (?, ?, ?, ?)",
  );
  const setStatus = client.prepare("UPDATE file SET parse_status = ? WHERE id = ?");

  const writeBatch = client.transaction((batch: ParsedFile[]) => {
    for (const item of batch) {
      setStatus.run(item.status, item.fileId);
      if (!item.result) continue;
      for (const symbol of item.result.definitions) {
        insertSymbol.run(
          item.fileId,
          symbol.name,
          symbol.kind,
          symbol.exported ? 1 : 0,
          symbol.startLine,
          symbol.endLine,
          symbol.signature,
          symbol.doc ?? null,
        );
      }
      for (const reference of item.result.references) {
        insertRef.run(item.fileId, reference.name, reference.kind, reference.line);
      }
    }
  });

  return {
    clear() {
      client.transaction(() => {
        client.prepare("DELETE FROM symbol_ref").run();
        client.prepare("DELETE FROM symbol").run();
        client.prepare("UPDATE file SET parse_status = 'skipped'").run();
      })();
    },
    write(batch: ParsedFile[]) {
      writeBatch(batch);
    },
  };
}
