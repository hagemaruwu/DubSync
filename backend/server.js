import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import dubRouter from './src/routes/dub.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3001;

// Ensure required directories exist
['audio-cache', 'temp'].forEach(dir => {
  mkdirSync(join(__dirname, dir), { recursive: true });
});

const app = express();

// Allow requests from any Chrome extension origin (localhost personal use)
app.use(cors({
  origin: (origin, callback) => {
    // Allow Chrome extensions, localhost, youtube.com, and no-origin requests (curl)
    if (!origin || origin.startsWith('chrome-extension://') || origin.startsWith('http://localhost') || origin.includes('youtube.com')) {
      callback(null, true);
    } else {
      callback(new Error(`CORS blocked: ${origin}`));
    }
  },
  methods: ['GET', 'POST'],
}));

app.use(express.json());

// Serve completed audio files
app.use('/audio-cache', express.static(join(__dirname, 'audio-cache')));

// API routes
app.use('/dub', dubRouter);

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🎙️  YouTube Hindi Dubber backend running on http://localhost:${PORT}`);
  console.log(`   Health: http://localhost:${PORT}/health\n`);
});
