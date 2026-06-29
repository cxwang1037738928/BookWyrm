import { Router } from 'express';
import { retrieve } from '../retrieval/retriever.js';

const router = Router();

// POST /api/query
// Body: { query: string, topK?: number }
router.post('/', async (req, res) => {
  const { query, topK } = req.body;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: '"query" is required and must be a non-empty string.' });
  }

  const k = Math.min(Math.max(parseInt(topK || process.env.TOP_K || '5', 10), 1), 20);

  try {
    const results = await retrieve(query.trim(), k);

    res.json({
      query: query.trim(),
      topK: k,
      results,
    });
  } catch (err) {
    console.error('[query]', err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
