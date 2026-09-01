/**
 * dub.js — Express router
 *
 * Routes:
 *  POST /dub              — Start a dubbing job
 *  GET  /dub/:jobId/status — Poll job status
 *  GET  /dub/:jobId/audio  — Stream completed audio
 */

import { Router } from 'express';
import { createReadStream, existsSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { createJob, getJob, setJobReady, setJobError } from '../jobStore.js';
import { fetchCaptions, CaptionNotAvailableError, VideoUnavailableError, YtDlpRuntimeError } from '../pipeline/captionFetcher.js';
import { translateSegments } from '../pipeline/translator.js';
import { synthesizeSegments } from '../pipeline/tts.js';
import { stitchClips } from '../pipeline/stitcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_DIR = join(__dirname, '..', '..');
const AUDIO_CACHE_DIR = join(BASE_DIR, 'audio-cache');
const TEMP_DIR = join(BASE_DIR, 'temp');


const router = Router();

// ─── POST /dub ───────────────────────────────────────────────────────────────

router.post('/', async (req, res) => {
  const { videoId } = req.body;

  if (!videoId || typeof videoId !== 'string' || !/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    return res.status(400).json({
      error: 'Invalid videoId. Must be an 11-character YouTube video ID.',
    });
  }

  const jobId = uuidv4();
  createJob(jobId, videoId);

  // Respond immediately — client starts polling
  res.status(202).json({ jobId });

  // Run pipeline asynchronously (fire-and-forget with error handling)
  runPipeline(jobId, videoId).catch(err => {
    console.error(`[job:${jobId}] Unhandled pipeline error:`, err);
    setJobError(jobId, 'PIPELINE_ERROR', 'An unexpected error occurred. Check server logs.');
  });
});

// ─── GET /dub/:jobId/status ───────────────────────────────────────────────────

router.get('/:jobId/status', (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.json({
    status: job.status,
    error: job.error ?? null,
    errorCode: job.errorCode ?? null,
    videoId: job.videoId,
  });
});

// ─── GET /dub/:jobId/audio ───────────────────────────────────────────────────

router.get('/:jobId/audio', (req, res) => {
  const job = getJob(req.params.jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  if (job.status !== 'ready') {
    return res.status(409).json({ error: `Job is not ready (status: ${job.status})` });
  }

  if (!job.audioPath || !existsSync(job.audioPath)) {
    return res.status(500).json({ error: 'Audio file not found on disk' });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', 'no-cache');
  createReadStream(job.audioPath).pipe(res);
});

// ─── Pipeline orchestration ───────────────────────────────────────────────────

async function runPipeline(jobId, videoId) {
  const tempJobDir = join(TEMP_DIR, jobId);
  const audioOutputPath = join(AUDIO_CACHE_DIR, jobId, 'dubbed.mp3');

  console.log(`\n[job:${jobId}] Starting pipeline for video: ${videoId}`);
  const t0 = Date.now();

  try {
    // 1. Fetch captions
    console.log(`[job:${jobId}] Step 1/4: Fetching captions...`);
    let segments;
    try {
      segments = await fetchCaptions(videoId, tempJobDir);
    } catch (err) {
      if (err instanceof VideoUnavailableError) {
        setJobError(jobId, err.code, 'Video is private, age-restricted, or unavailable.');
      } else if (err instanceof CaptionNotAvailableError) {
        setJobError(jobId, err.code, 'No English captions found for this video. Try a video with CC enabled.');
      } else if (err instanceof YtDlpRuntimeError) {
        setJobError(jobId, err.code, `Caption fetch failed. Run 'yt-dlp -U' to update. (${err.message.slice(0, 200)})`);
      } else {
        throw err; // Re-throw unexpected errors
      }
      return;
    }

    console.log(`[job:${jobId}]   → ${segments.length} sentence segments after cleaning`);

    // 2. Translate to Hindi
    console.log(`[job:${jobId}] Step 2/4: Translating ${segments.length} segments to Hindi...`);
    const englishTexts = segments.map(s => s.text);
    const hindiTexts = await translateSegments(null, englishTexts);
    const hindiSegments = segments.map((seg, i) => ({
      ...seg,
      text: hindiTexts[i] || seg.text, // fallback to English if translation failed
    }));

    // 3. TTS synthesis
    console.log(`[job:${jobId}] Step 3/4: Synthesizing ${hindiSegments.length} Hindi audio clips (concurrency: ${process.env.TTS_CONCURRENCY || 8})...`);
    const clips = await synthesizeSegments(hindiSegments, tempJobDir);

    console.log(`[job:${jobId}]   → TTS complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    // 4. Stitch
    console.log(`[job:${jobId}] Step 4/4: Stitching audio with drift correction...`);
    await stitchClips(clips, audioOutputPath);

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[job:${jobId}] ✅ Pipeline complete in ${elapsed}s → ${audioOutputPath}`);

    setJobReady(jobId, audioOutputPath);

  } catch (err) {
    console.error(`[job:${jobId}] ❌ Pipeline error:`, err.message);
    setJobError(jobId, 'PIPELINE_ERROR', `Processing failed: ${err.message}`);
  } finally {
    // Always clean up temp files
    await rm(tempJobDir, { recursive: true, force: true }).catch(() => {});
  }
}

export default router;
