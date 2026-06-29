import fs from 'fs/promises';
import path from 'path';

const STORE_PATH = process.env.EMBEDDINGS_PATH
  ? path.resolve(process.env.EMBEDDINGS_PATH)
  : path.resolve('./data/embeddings.json');

/**
 * Reads the entire store from disk.
 * @returns {Promise<{chunks: ChunkRecord[], metadata: object}>}
 */
export async function readStore() {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return { chunks: [], metadata: { model: 'Xenova/all-MiniLM-L6-v2', dimensions: 384, created: null, updated: null } };
  }
}

/**
 * Overwrites the store on disk.
 * @param {{chunks: ChunkRecord[], metadata: object}} store
 */
export async function writeStore(store) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
  await fs.writeFile(STORE_PATH, JSON.stringify(store, null, 2), 'utf-8');
}

/**
 * Appends new chunk records to the store.
 * @param {ChunkRecord[]} newChunks
 */
export async function appendChunks(newChunks) {
  const store = await readStore();
  store.chunks.push(...newChunks);
  store.metadata.updated = new Date().toISOString();
  if (!store.metadata.created) store.metadata.created = store.metadata.updated;
  await writeStore(store);
}

/**
 * Removes all chunks belonging to a document by docId.
 * @param {string} docId
 */
export async function removeDocument(docId) {
  const store = await readStore();
  store.chunks = store.chunks.filter((c) => c.docId !== docId);
  store.metadata.updated = new Date().toISOString();
  await writeStore(store);
}

/**
 * Returns all unique documents tracked in the store.
 * @returns {Promise<Array<{docId: string, filename: string, numChunks: number, ingestedAt: string}>>}
 */
export async function listDocuments() {
  const store = await readStore();
  const docs = new Map();
  for (const chunk of store.chunks) {
    if (!docs.has(chunk.docId)) {
      docs.set(chunk.docId, { docId: chunk.docId, filename: chunk.filename, numChunks: 0, ingestedAt: chunk.ingestedAt });
    }
    docs.get(chunk.docId).numChunks++;
  }
  return Array.from(docs.values());
}

/**
 * @typedef {object} ChunkRecord
 * @property {string}   id          - unique chunk id
 * @property {string}   docId       - document id (filename hash or uuid)
 * @property {string}   filename    - original PDF filename
 * @property {number}   pageNumber  - page the chunk came from
 * @property {number}   chunkIndex  - index within that page
 * @property {string}   text        - raw chunk text
 * @property {number[]} embedding   - 384-dim normalized float vector
 * @property {string}   ingestedAt  - ISO timestamp
 */
