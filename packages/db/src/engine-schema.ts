import { FILE_KINDS, MODULE_KINDS, SIZE_TIERS } from "@everyrepo/core";
import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    // Java package or Go package clause, used for import resolution
    packageName: text("package_name"),
    pagerank: real("pagerank"),
    clusterId: integer("cluster_id"),
  },
  (table) => [index("file_module").on(table.moduleId), index("file_kind").on(table.kind)],
);

export const fileImports = sqliteTable(
  "file_import",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    specifier: text("specifier").notNull(),
    kind: text("kind").notNull(),
    names: text("names", { mode: "json" }).$type<string[]>(),
    line: integer("line").notNull(),
    // resolved, external or unresolved
    resolution: text("resolution"),
  },
  (table) => [index("file_import_file").on(table.fileId)],
);

export const EDGE_KINDS = ["import", "reference", "cochange"] as const;

export const edges = sqliteTable(
  "edge",
  {
    srcFileId: integer("src_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    dstFileId: integer("dst_file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: EDGE_KINDS }).notNull(),
    weight: real("weight").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.srcFileId, table.dstFileId, table.kind] }),
    index("edge_dst").on(table.dstFileId),
  ],
);

export const clusters = sqliteTable("cluster", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  key: text("key").notNull().unique(),
  moduleId: integer("module_id").references(() => modules.id),
  label: text("label").notNull(),
  fileCount: integer("file_count").notNull(),
  tokenCount: integer("token_count").notNull(),
  topFiles: text("top_files", { mode: "json" }).$type<string[]>().notNull(),
});

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

export const chunks = sqliteTable(
  "chunk",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fileId: integer("file_id")
      .notNull()
      .references(() => files.id, { onDelete: "cascade" }),
    // One-based, inclusive line range, matching symbol line numbers
    startLine: integer("start_line").notNull(),
    endLine: integer("end_line").notNull(),
    kind: text("kind", { enum: ["code", "markdown", "text"] }).notNull(),
    header: text("header").notNull(),
    content: text("content").notNull(),
    identifiers: text("identifiers").notNull(),
    tokens: integer("tokens").notNull(),
  },
  (table) => [index("chunk_file").on(table.fileId)],
);
