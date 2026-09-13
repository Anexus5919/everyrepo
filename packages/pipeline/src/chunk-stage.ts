import { estimateTokens } from "@everyrepo/core";
import {
  chunkCode,
  chunkMarkdown,
  chunkText,
  identifierTerms,
  type LineChunk,
} from "@everyrepo/chunk";
import { openEngineDb } from "@everyrepo/db";
import { BlobReader } from "@everyrepo/repo";

export interface ChunkInput {
  enginePath: string;
  gitDir: string;
  log: (message: string) => void;
  heartbeat: () => void;
}

export interface ChunkOutput {
  files: number;
  chunks: number;
  tokens: number;
  seconds: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const MARKDOWN_LANGUAGES = new Set(["markdown", "mdx", "rst"]);
const PLAIN_DOC_LANGUAGES = new Set(["asciidoc", "text", "html"]);
const MAX_DEFINES_IN_HEADER = 4;

interface FileRow {
  id: number;
  path: string;
  oid: string;
  language: string | null;
  kind: string;
  moduleName: string;
}

interface SymbolRow {
  fileId: number;
  name: string;
  startLine: number;
  endLine: number;
}

// Headers give each chunk its context: file, module, enclosing symbols and headings
function headerFor(file: FileRow, chunk: LineChunk, symbols: readonly SymbolRow[]): string {
  const start = chunk.startLine + 1;
  const end = chunk.endLine + 1;
  const scope = symbols
    .filter((symbol) => symbol.startLine < start && symbol.endLine >= start)
    .sort((a, b) => b.endLine - b.startLine - (a.endLine - a.startLine))
    .map((symbol) => symbol.name);
  const defines = symbols
    .filter((symbol) => symbol.startLine >= start && symbol.startLine <= end)
    .slice(0, MAX_DEFINES_IN_HEADER)
    .map((symbol) => symbol.name);
  return [
    file.path,
    file.moduleName ? `module ${file.moduleName}` : "",
    scope.length > 0 ? `in ${scope.join(" > ")}` : "",
    defines.length > 0 ? `defines ${defines.join(", ")}` : "",
    chunk.headings && chunk.headings.length > 0 ? chunk.headings.join(" > ") : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export async function runChunkStage(input: ChunkInput): Promise<ChunkOutput> {
  const started = Date.now();
  const engine = openEngineDb(input.enginePath);
  const sql = engine.$client;
  const reader = new BlobReader(input.gitDir);
  try {
    const files = (
      sql
        .prepare(
          `SELECT f.id, f.path, f.oid, f.language, f.kind, COALESCE(m.name, '') AS moduleName
           FROM file f LEFT JOIN module m ON m.id = f.module_id
           WHERE f.kind IN ('src', 'types', 'docs') AND f.bytes <= ?
           ORDER BY f.path`,
        )
        .all(MAX_FILE_BYTES) as FileRow[]
    ).filter(
      (file) =>
        file.kind !== "docs" ||
        MARKDOWN_LANGUAGES.has(file.language ?? "") ||
        PLAIN_DOC_LANGUAGES.has(file.language ?? ""),
    );

    const symbolsByFile = new Map<number, SymbolRow[]>();
    const symbolRows = sql
      .prepare(
        "SELECT file_id AS fileId, name, start_line AS startLine, end_line AS endLine FROM symbol ORDER BY file_id, start_line",
      )
      .all() as SymbolRow[];
    for (const symbol of symbolRows) {
      const list = symbolsByFile.get(symbol.fileId);
      if (list) list.push(symbol);
      else symbolsByFile.set(symbol.fileId, [symbol]);
    }

    sql.transaction(() => {
      sql.prepare("DELETE FROM chunk").run();
      sql.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('delete-all')").run();
    })();
    const insert = sql.prepare(
      "INSERT INTO chunk (file_id, start_line, end_line, kind, header, content, identifiers, tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const writeBatch = sql.transaction(
      (rows: Array<[number, number, number, string, string, string, string, number]>) => {
        for (const row of rows) insert.run(...row);
      },
    );

    let chunkCount = 0;
    let tokenCount = 0;
    let batch: Array<[number, number, number, string, string, string, string, number]> = [];
    for (const [index, file] of files.entries()) {
      const text = await reader.readText(file.oid);
      const lines = text.split(/\r?\n/);
      const language = file.language ?? "";
      const lineChunks = MARKDOWN_LANGUAGES.has(language)
        ? chunkMarkdown(text)
        : file.kind === "docs"
          ? chunkText(text)
          : await chunkCode(language, text).catch(() => chunkText(text));
      const symbols = symbolsByFile.get(file.id) ?? [];
      for (const chunk of lineChunks) {
        const content = lines.slice(chunk.startLine, chunk.endLine + 1).join("\n");
        const tokens = estimateTokens(Buffer.byteLength(content));
        batch.push([
          file.id,
          chunk.startLine + 1,
          chunk.endLine + 1,
          chunk.kind,
          headerFor(file, chunk, symbols),
          content,
          identifierTerms(content),
          tokens,
        ]);
        chunkCount += 1;
        tokenCount += tokens;
      }
      if (batch.length >= 500) {
        writeBatch(batch);
        batch = [];
      }
      if ((index + 1) % 1000 === 0) {
        input.heartbeat();
        input.log(`chunked ${index + 1}/${files.length} files`);
      }
    }
    writeBatch(batch);
    sql.prepare("INSERT INTO chunk_fts(chunk_fts) VALUES('rebuild')").run();

    const output: ChunkOutput = {
      files: files.length,
      chunks: chunkCount,
      tokens: tokenCount,
      seconds: Math.round((Date.now() - started) / 100) / 10,
    };
    input.log(
      `${output.chunks} chunks (${output.tokens} tokens) from ${output.files} files in ${output.seconds}s`,
    );
    return output;
  } finally {
    await reader.close();
    sql.close();
  }
}
