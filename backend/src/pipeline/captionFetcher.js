/**
 * captionFetcher.js
 *
 * Fetches English captions for a YouTube video using yt-dlp,
 * then parses + cleans the SRT output into structured, sentence-grouped segments
 * suitable for translation and TTS synthesis.
 *
 * Error types thrown:
 *  - CaptionNotAvailableError  — video exists but has no English captions
 *  - VideoUnavailableError     — video is private, age-restricted, or removed
 *  - YtDlpRuntimeError         — yt-dlp binary issue or unexpected failure
 */

import { spawn } from 'child_process';
import { readdir, readFile, rm } from 'fs/promises';
import { join } from 'path';

// ─── Custom error classes ────────────────────────────────────────────────────

export class CaptionNotAvailableError extends Error {
  constructor(videoId) {
    super(`No English captions found for video: ${videoId}`);
    this.name = 'CaptionNotAvailableError';
    this.code = 'NO_CAPTIONS';
  }
}

export class VideoUnavailableError extends Error {
  constructor(reason) {
    super(`Video unavailable: ${reason}`);
    this.name = 'VideoUnavailableError';
    this.code = 'VIDEO_UNAVAILABLE';
  }
}

export class YtDlpRuntimeError extends Error {
  constructor(stderr, exitCode) {
    super(`yt-dlp failed (exit ${exitCode}). Run 'yt-dlp -U' to update. Details: ${stderr.slice(-500)}`);
    this.name = 'YtDlpRuntimeError';
    this.code = 'YTDLP_ERROR';
  }
}

// ─── Main export ─────────────────────────────────────────────────────────────

/**
 * Fetch, parse, clean and group captions for a YouTube video.
 * @param {string} videoId  YouTube video ID (e.g. "dQw4w9WgXcQ")
 * @param {string} outputDir  Directory to write temp .srt files
 * @returns {Promise<Array<{startSec: number, endSec: number, text: string}>>}
 *   Cleaned, sentence-grouped segments ready for translation.
 */
export async function fetchCaptions(videoId, outputDir) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  // Run yt-dlp to download subtitles only
  const stderr = await runYtDlp(url, outputDir);

  // Detect video-level errors from stderr
  detectVideoErrors(stderr);

  // Find the .srt file written by yt-dlp (prefers manual 'en' over 'en-orig')
  const srtPath = await findSrtFile(outputDir);
  if (!srtPath) {
    throw new CaptionNotAvailableError(videoId);
  }

  const srtContent = await readFile(srtPath, 'utf-8');
  const rawCues = parseSrt(srtContent);
  const cleaned = cleanCues(rawCues);
  const grouped = groupIntoSentences(cleaned);

  return grouped;
}

// ─── yt-dlp runner ───────────────────────────────────────────────────────────

function runYtDlp(url, outputDir) {
  return new Promise((resolve, reject) => {
    const args = [
      url,
      '--write-sub',           // prefer manual subs
      '--write-auto-sub',      // fallback to auto-generated
      '--sub-lang', 'en,en-orig,en-US',
      '--sub-format', 'srt',
      '--skip-download',       // don't download the video
      '--no-playlist',
      '--quiet',
      '--no-warnings',
      '-o', join(outputDir, '%(id)s.%(ext)s'),
    ];

    const proc = spawn('yt-dlp', args);
    let outBuf = '';

    proc.stdout.on('data', chunk => { outBuf += chunk.toString(); });
    proc.stderr.on('data', chunk => { outBuf += chunk.toString(); });

    proc.on('close', exitCode => {
      if (exitCode === 0) {
        resolve(outBuf);
      } else {
        // Check for recognisable error patterns before throwing generic error
        const combinedOutput = outBuf.toLowerCase();
        if (
          combinedOutput.includes('video unavailable') ||
          combinedOutput.includes('this video is private') ||
          combinedOutput.includes('sign in to confirm your age') ||
          combinedOutput.includes('has been removed')
        ) {
          reject(new VideoUnavailableError(extractVideoErrorReason(outBuf)));
        } else {
          reject(new YtDlpRuntimeError(outBuf, exitCode));
        }
      }
    });

    proc.on('error', err => {
      if (err.code === 'ENOENT') {
        reject(new YtDlpRuntimeError(
          'yt-dlp binary not found. Install with: brew install yt-dlp',
          -1
        ));
      } else {
        reject(new YtDlpRuntimeError(err.message, -1));
      }
    });
  });
}

function detectVideoErrors(stderr) {
  const lower = stderr.toLowerCase();
  if (
    lower.includes('video unavailable') ||
    lower.includes('this video is private') ||
    lower.includes('sign in to confirm your age') ||
    lower.includes('has been removed')
  ) {
    throw new VideoUnavailableError(extractVideoErrorReason(stderr));
  }
}

function extractVideoErrorReason(stderr) {
  const lines = stderr.split('\n').filter(Boolean);
  // Return the most relevant line (usually the last meaningful one)
  for (const line of lines.reverse()) {
    if (line.length > 10) return line.trim();
  }
  return 'Unknown reason';
}

// ─── SRT file finder ─────────────────────────────────────────────────────────

async function findSrtFile(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }

  // Prefer manual English captions (en) over auto-generated (en-orig, en-US)
  const srtFiles = files.filter(f => f.endsWith('.srt'));
  if (srtFiles.length === 0) return null;

  const priority = ['en.srt', 'en-US.srt', 'en-orig.srt'];
  for (const p of priority) {
    const found = srtFiles.find(f => f.endsWith(p));
    if (found) return join(dir, found);
  }

  // Fallback to any .srt
  return join(dir, srtFiles[0]);
}

// ─── SRT parser ──────────────────────────────────────────────────────────────

/**
 * Parse SRT format into raw cue objects.
 * @returns {Array<{index: number, startSec: number, endSec: number, text: string}>}
 */
function parseSrt(content) {
  const cues = [];
  // Normalize line endings and split into blocks
  const blocks = content.replace(/\r\n/g, '\n').trim().split(/\n\n+/);

  for (const block of blocks) {
    const lines = block.trim().split('\n');
    if (lines.length < 3) continue;

    // Line 0: sequence number
    const index = parseInt(lines[0].trim(), 10);
    if (isNaN(index)) continue;

    // Line 1: timestamp "HH:MM:SS,mmm --> HH:MM:SS,mmm"
    const timeParts = lines[1].match(
      /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/
    );
    if (!timeParts) continue;

    const startSec = toSeconds(timeParts[1], timeParts[2], timeParts[3], timeParts[4]);
    const endSec = toSeconds(timeParts[5], timeParts[6], timeParts[7], timeParts[8]);

    // Lines 2+: text content (strip HTML tags)
    const rawText = lines.slice(2).join(' ');
    const text = stripHtml(rawText).trim();

    if (text) {
      cues.push({ index, startSec, endSec, text });
    }
  }

  return cues;
}

function toSeconds(h, m, s, ms) {
  return parseInt(h) * 3600 + parseInt(m) * 60 + parseInt(s) + parseInt(ms) / 1000;
}

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, '')   // remove HTML tags
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')      // collapse whitespace
    .trim();
}

// ─── Caption cleaning ─────────────────────────────────────────────────────────

/**
 * Deduplicate near-identical consecutive cues (auto-caption artifact).
 * YouTube auto-captions repeat/refine the same phrase across 2-3 cues.
 * Strategy: if cue text is highly similar to the previous cue, drop it
 * and extend the previous cue's end time.
 */
function cleanCues(cues) {
  if (cues.length === 0) return [];

  const cleaned = [{ ...cues[0] }];

  for (let i = 1; i < cues.length; i++) {
    const prev = cleaned[cleaned.length - 1];
    const curr = cues[i];

    // Check if current cue is a near-duplicate of the previous
    if (isNearDuplicate(prev.text, curr.text)) {
      // Extend the previous cue's end time to absorb this cue
      prev.endSec = Math.max(prev.endSec, curr.endSec);
      // Keep the longer/more complete text
      if (curr.text.length > prev.text.length) {
        prev.text = curr.text;
      }
    } else {
      cleaned.push({ ...curr });
    }
  }

  return cleaned;
}

/**
 * Returns true if two strings are near-duplicates.
 * Uses simple substring containment check + normalized overlap ratio.
 */
function isNearDuplicate(a, b) {
  if (!a || !b) return false;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;

  // If one is a substring of the other, it's definitely a duplicate
  if (longer.toLowerCase().includes(shorter.toLowerCase())) return true;

  // Compute word-level overlap
  const wordsA = new Set(a.toLowerCase().split(/\s+/));
  const wordsB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccardSimilarity = intersection / union;

  return jaccardSimilarity > 0.7; // 70%+ word overlap = near-duplicate
}

// ─── Sentence grouping ───────────────────────────────────────────────────────

const SENTENCE_END = /[.!?।…]$/;
const MAX_GROUP_DURATION_SEC = 8;

/**
 * Merge consecutive cues into sentence-level groups.
 * Each group is the atomic unit sent to Translation + TTS.
 *
 * @returns {Array<{startSec: number, endSec: number, text: string}>}
 */
function groupIntoSentences(cues) {
  if (cues.length === 0) return [];

  const groups = [];
  let currentGroup = null;

  for (const cue of cues) {
    if (!currentGroup) {
      currentGroup = {
        startSec: cue.startSec,
        endSec: cue.endSec,
        text: cue.text,
      };
    } else {
      const groupDuration = cue.endSec - currentGroup.startSec;
      const prevEndsWithSentence = SENTENCE_END.test(currentGroup.text.trim());

      if (prevEndsWithSentence || groupDuration >= MAX_GROUP_DURATION_SEC) {
        // Flush current group
        groups.push(currentGroup);
        currentGroup = {
          startSec: cue.startSec,
          endSec: cue.endSec,
          text: cue.text,
        };
      } else {
        // Accumulate into current group
        currentGroup.endSec = cue.endSec;
        currentGroup.text = currentGroup.text.trimEnd() + ' ' + cue.text;
      }
    }
  }

  // Flush last group
  if (currentGroup) groups.push(currentGroup);

  return groups;
}
