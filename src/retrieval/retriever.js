import { embed } from '../ingestion/embedder.js';
import { readStore } from '../storage/store.js';
import { topKChunks } from './similarity.js';

/**
 * Retrieves the top-k most relevant chunks for a natural language query.
 * @param {string} query
 * @param {number} topK
 * @returns {Promise<Array<{text: string, score: number, docId: string, filename: string, pageNumber: number}>>}
 */
export async function retrieve(query, topK = 5) {
  const [queryVec, store] = await Promise.all([embed(query), readStore()]);

  if (store.chunks.length === 0) {
    return [];
  }

  const results = topKChunks(queryVec, store.chunks, topK);

  return results.map(({ chunk, score }) => ({
    text: chunk.text,
    score: parseFloat(score.toFixed(4)),
    docId: chunk.docId,
    filename: chunk.filename,
    pageNumber: chunk.pageNumber,
    chunkIndex: chunk.chunkIndex,
  }));
}
