/**
 * Computes cosine similarity between two normalized vectors.
 * Since embeddings from all-MiniLM-L6-v2 are L2-normalized, this is just a dot product.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} similarity in [-1, 1]
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);

  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot;
}

/**
 * Ranks all chunks by cosine similarity to the query vector and returns the top-k.
 * @param {number[]}       queryVec  - normalized query embedding
 * @param {import('../storage/store.js').ChunkRecord[]} chunks - all stored chunks
 * @param {number}         topK
 * @returns {Array<{chunk: ChunkRecord, score: number}>}
 */
export function topKChunks(queryVec, chunks, topK = 5) {
  const scored = chunks.map((chunk) => ({
    chunk,
    score: cosineSimilarity(queryVec, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, topK);
}
