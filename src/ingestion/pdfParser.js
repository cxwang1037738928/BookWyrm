import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import fs from 'fs/promises';

/**
 * Parses a PDF file and returns page-level text with metadata.
 * @param {string} filePath - absolute path to the PDF
 * @returns {Promise<{ text: string, pages: Array<{ pageNumber: number, text: string }>, info: object }>}
 */
export async function parsePDF(filePath) {
  const buffer = await fs.readFile(filePath);

  const pages = [];

  const options = {
    pagerender(pageData) {
      return pageData.getTextContent().then((content) => {
        const pageText = content.items.map((item) => item.str).join(' ');
        pages.push({ pageNumber: pageData.pageNumber, text: pageText.trim() });
        return pageText;
      });
    },
  };

  const result = await pdfParse(buffer, options);

  return {
    text: result.text,
    pages,
    info: {
      numPages: result.numpages,
      title: result.info?.Title || null,
      author: result.info?.Author || null,
      subject: result.info?.Subject || null,
    },
  };
}
