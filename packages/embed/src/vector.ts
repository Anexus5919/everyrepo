export function normalize(vector: Float32Array, dimensions = vector.length): Float32Array {
  const result = vector.slice(0, dimensions);
  let norm = 0;
  for (const value of result) norm += value * value;
  norm = Math.sqrt(norm);
  if (norm > 0) for (let index = 0; index < result.length; index += 1) result[index]! /= norm;
  return result;
}

export function toBlob(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

export function fromBlob(blob: Uint8Array): Float32Array {
  // Copy so the result owns aligned memory regardless of the source buffer offset
  const bytes = new Uint8Array(blob);
  return new Float32Array(bytes.buffer, 0, bytes.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!;
  return sum;
}
