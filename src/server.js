import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import ingestRouter from './routes/ingest.js';
import queryRouter from './routes/query.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.use('/api/ingest', ingestRouter);
app.use('/api/query', queryRouter);

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`BookWyrm RAG server running on http://localhost:${PORT}`);
  console.log('  POST /api/ingest        — upload a PDF (multipart field: "pdf")');
  console.log('  GET  /api/ingest        — list ingested documents');
  console.log('  DELETE /api/ingest/:id  — remove a document');
  console.log('  POST /api/query         — { query, topK? }');
});
