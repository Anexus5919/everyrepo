export interface DefinitionRow {
  fileId: number;
  name: string;
}

export interface ReferenceCount {
  fileId: number;
  name: string;
  count: number;
}

export interface WeightedEdge {
  src: number;
  dst: number;
  weight: number;
}

const MIN_NAME_LENGTH = 3;
const MAX_DEFINING_FILES = 5;
// Names such as get or toString are defined almost everywhere and carry no structure
const IGNORE_ABOVE_DEFINING_FILES = 20;

// Links a file to the files defining the names it uses; distinctive names count more
export function referenceEdges(
  definitions: readonly DefinitionRow[],
  references: readonly ReferenceCount[],
): WeightedEdge[] {
  const definers = new Map<string, Set<number>>();
  for (const definition of definitions) {
    let set = definers.get(definition.name);
    if (!set) definers.set(definition.name, (set = new Set()));
    set.add(definition.fileId);
  }

  const weights = new Map<string, WeightedEdge>();
  for (const reference of references) {
    const files = definers.get(reference.name);
    if (
      !files ||
      files.size > IGNORE_ABOVE_DEFINING_FILES ||
      reference.name.length < MIN_NAME_LENGTH
    ) {
      continue;
    }
    let multiplier = 1;
    const distinctive = reference.name.length >= 8 && /[a-z][A-Z]|_[a-zA-Z]/.test(reference.name);
    if (distinctive) multiplier *= 10;
    if (reference.name.startsWith("_")) multiplier *= 0.1;
    if (files.size > MAX_DEFINING_FILES) multiplier *= 0.1;
    const weight = multiplier * Math.sqrt(reference.count);
    for (const dst of files) {
      if (dst === reference.fileId) continue;
      const key = `${reference.fileId}:${dst}`;
      const existing = weights.get(key);
      if (existing) existing.weight += weight;
      else weights.set(key, { src: reference.fileId, dst, weight });
    }
  }
  return [...weights.values()];
}
