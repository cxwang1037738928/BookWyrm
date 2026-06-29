import { pipeline } from '@xenova/transformers';

const MODEL = 'Xenova/all-MiniLM-L6-v2';

let _extractor = null;

async function getExtractor() {
  if (!_extractor) {
    _extractor = await pipeline('feature-extraction', MODEL, {
      quantized: true, // smaller model footprint
    });
  }
  return _extractor;
}

/**
 * Generates a normalized embedding vector for a single text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embed(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

/**
 * Generates embeddings for an array of texts in batches to avoid OOM.
 * @param {string[]} texts
 * @param {number} batchSize
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(texts, batchSize = 32) {
  const extractor = await getExtractor();
  const results = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const output = await extractor(batch, { pooling: 'mean', normalize: true });

    // output.data is a flat Float32Array of shape [batchSize * dims]
    const dims = output.data.length / batch.length;
    for (let j = 0; j < batch.length; j++) {
      results.push(Array.from(output.data.slice(j * dims, (j + 1) * dims)));
    }
  }

  return results;
}
