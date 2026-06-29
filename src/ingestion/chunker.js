/**
 * Splits text into overlapping chunks, preserving sentence boundaries where possible.
 * @param {string} text
 * @param {number} chunkSize  - target chunk size in characters
 * @param {number} overlap    - overlap in characters between consecutive chunks
 * @returns {string[]}
 */
export function chunkText(text, chunkSize = 500, overlap = 50) {
  const sentences = text
    .replace(/\r\n/g, '\n')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const chunks = [];
  let current = '';

  for (const sentence of sentences) {
    if (current.length + sentence.length + 1 <= chunkSize) {
      current = current ? `${current} ${sentence}` : sentence;
    } else {
      if (current) chunks.push(current.trim());

      // start next chunk with overlap from end of previous chunk
      const overlapText = current.slice(-overlap);
      current = overlapText ? `${overlapText} ${sentence}` : sentence;
    }
  }

  if (current.trim()) chunks.push(current.trim());

  return chunks.filter((c) => c.length > 20);
}

/**
 * Chunks page-level output from the PDF parser, attaching page metadata.
 * @param {Array<{pageNumber: number, text: string}>} pages
 * @param {number} chunkSize
 * @param {number} overlap
 * @returns {Array<{text: string, pageNumber: number, chunkIndex: number}>}
 */
export function chunkPages(pages, chunkSize = 500, overlap = 50) {
  const result = [];
  for (const page of pages) {
    if (!page.text) continue;
    const pageChunks = chunkText(page.text, chunkSize, overlap);
    pageChunks.forEach((text, i) => {
      result.push({ text, pageNumber: page.pageNumber, chunkIndex: i });
    });
  }
  return result;
}
