import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { parsePDF } from '../ingestion/pdfParser.js';
import { chunkPages } from '../ingestion/chunker.js';
import { embedBatch } from '../ingestion/embedder.js';
import { appendChunks, listDocuments, removeDocument } from '../storage/store.js';

const router = Router();

const UPLOADS_DIR = path.resolve(process.env.UPLOADS_DIR || './uploads');

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    await fs.mkdir(UPLOADS_DIR, { recursive: true });
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/\s+/g, '_');
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Only PDF files are accepted'), false);
  },
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

// POST /api/ingest  — upload + process a PDF
router.post('/', upload.single('pdf'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No PDF file uploaded. Use field name "pdf".' });

  const filePath = req.file.path;
  const filename = req.file.originalname;

  try {
    const chunkSize = parseInt(process.env.CHUNK_SIZE || '500', 10);
    const chunkOverlap = parseInt(process.env.CHUNK_OVERLAP || '50', 10);

    // 1. Parse
    const { pages, info } = await parsePDF(filePath);

    // 2. Chunk
    const rawChunks = chunkPages(pages, chunkSize, chunkOverlap);
    if (rawChunks.length === 0) {
      return res.status(422).json({ error: 'No extractable text found in this PDF.' });
    }

    // 3. Embed
    const texts = rawChunks.map((c) => c.text);
    const embeddings = await embedBatch(texts);

    // 4. Build records
    const docId = crypto.createHash('sha256').update(filename + Date.now()).digest('hex').slice(0, 16);
    const ingestedAt = new Date().toISOString();

    const records = rawChunks.map((chunk, i) => ({
      id: `${docId}_${chunk.pageNumber}_${chunk.chunkIndex}`,
      docId,
      filename,
      pageNumber: chunk.pageNumber,
      chunkIndex: chunk.chunkIndex,
      text: chunk.text,
      embedding: embeddings[i],
      ingestedAt,
    }));

    // 5. Persist
    await appendChunks(records);

    res.json({
      docId,
      filename,
      numPages: info.numPages,
      numChunks: records.length,
      ingestedAt,
    });
  } catch (err) {
    console.error('[ingest]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/ingest  — list all ingested documents
router.get('/', async (_req, res) => {
  try {
    const docs = await listDocuments();
    res.json({ documents: docs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/ingest/:docId  — remove a document and its chunks
router.delete('/:docId', async (req, res) => {
  try {
    await removeDocument(req.params.docId);
    res.json({ deleted: req.params.docId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
