import { FILE_KINDS, MODULE_KINDS, SIZE_TIERS } from "@everyrepo/core";
import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const snapshots = sqliteTable("snapshot", {
  sha: text("sha").primaryKey(),
  repo: text("repo").notNull(),
  ref: text("ref").notNull(),
  engineVersion: text("engine_version").notNull(),
  sizeTier: text("size_tier", { enum: SIZE_TIERS }),
  sourceTokens: integer("source_tokens"),
  stats: text("stats", { mode: "json" }).$type<Record<string, unknown>>(),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const modules = sqliteTable("module", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  kind: text("kind", { enum: MODULE_KINDS }).notNull(),
  license: text("license"),
  parentId: integer("parent_id"),
});

export const files = sqliteTable(
  "file",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    path: text("path").notNull().unique(),
    oid: text("oid").notNull(),
    bytes: integer("bytes").notNull(),
    tokens: integer("tokens").notNull(),
    language: text("language"),
    kind: text("kind", { enum: FILE_KINDS }).notNull(),
    moduleId: integer("module_id").references(() => modules.id),
    parseStatus: text("parse_status", { enum: ["skipped", "ok", "partial", "failed"] })
      .notNull()
      .default("skipped"),
  },
  (table) => [index("file_module").on(table.moduleId), index("file_kind").on(table.kind)],
);

export const symbols = sqliteTable(
  "symbol",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    exported: integer("exported", { mode: "boolean" }).notNull(),
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    signature: text("signature").notNull(),
    doc: text("doc"),
  },
  (table) => [index("symbol_file").on(table.fileId), index("symbol_name").on(table.name)],
);

export const symbolRefs = sqliteTable(
  "symbol_ref",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    line: integer("line").notNull(),
  },
  (table) => [index("symbol_ref_file").on(table.fileId), index("symbol_ref_name").on(table.name)],
);
