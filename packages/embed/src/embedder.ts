export type EmbedPurpose = "query" | "document";

export interface Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly batchSize: number;
  // Requests the provider handles well in parallel; 1 when omitted
  readonly concurrency?: number;
  embed(texts: readonly string[], purpose: EmbedPurpose): Promise<Float32Array[]>;
}

export const QUERY_INSTRUCTION =
  "Given a question about a software repository, retrieve the source code or documentation that answers it";

// Instruction-aware models expect queries in this exact shape; documents are embedded as is
export function formatQuery(text: string): string {
  return `Instruct: ${QUERY_INSTRUCTION}\nQuery:${text}`;
}

// Long inputs are cut so a single chunk never exceeds the model context
export const MAX_DOCUMENT_CHARS = 8_000;

export function documentText(header: string, content: string): string {
  return `${header}\n${content}`.slice(0, MAX_DOCUMENT_CHARS);
}
