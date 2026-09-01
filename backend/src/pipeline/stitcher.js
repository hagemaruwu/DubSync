/**
 * stitcher.js
 *
 * Assembles individual Hindi TTS audio clips into a single dubbed audio track
 * that aligns with the original YouTube video timeline.
 *
 * DRIFT CORRECTION STRATEGY:
 * The stitcher is the single authority on timing. It pre-corrects sync at build time.
 * The content script trusts this timeline and only re-syncs on seek events.
 *
 * For each segment slot:
 *  - slot duration = next segment's startSec - this segment's startSec
 *  - if clip fits: clip + silence padding to fill slot
 *  - if clip is too long:
 *      apply atempo=min(clipDuration/slot, MAX_TEMPO) to speed up
 *      if still overrunning after max cap: accept it (clip overruns into next slot)
 *
 * OUTPUT: single MP3 file at audioOutputPath
 *
 * APPROACH:
 * 1. For each segment: build a "padded clip" = tempo-adjusted clip + silence gap
 * 2. Concatenate all padded clips in sequence
 * 3. This avoids complex timeline mixing while maintaining accurate timestamps
 *
 * NOTE: ffmpeg complex filter graph is built programmatically.
 * Each segment gets its own atempo + silence chain, then all are concatenated.
 */

import ffmpeg from 'fluent-ffmpeg';
import { writeFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { mkdirSync } from 'fs';

const MAX_TEMPO = parseFloat(process.env.STITCHER_MAX_TEMPO || '1.35');
const AUDIO_BITRATE = '128k';
const SAMPLE_RATE = 22050; // Hz — match TTS output to avoid resampling artifacts

/**
 * Stitch TTS clips into a single dubbed audio file.
 *
 * @param {Array<{index, startSec, endSec, filePath, durationSec}>} clips
 *   From tts.js — sorted by index
 * @param {string} outputPath  Full path for the output MP3 file
 * @returns {Promise<void>}
 */
export async function stitchClips(clips, outputPath) {
  if (clips.length === 0) {
    throw new Error('No clips to stitch');
  }

  // Ensure output directory exists
  mkdirSync(dirname(outputPath), { recursive: true });

  // For very small videos (single clip), just copy it
  if (clips.length === 1) {
    await stitchSingle(clips[0], outputPath);
    return;
  }

  // Build filter graph for multi-clip stitching
  await stitchMultiple(clips, outputPath);
}

// ─── Single clip (edge case) ─────────────────────────────────────────────────

async function stitchSingle(clip, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(clip.filePath)
      .audioBitrate(AUDIO_BITRATE)
      .save(outputPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`ffmpeg single-clip stitch failed: ${err.message}`)));
  });
}

// ─── Multi-clip stitching ────────────────────────────────────────────────────

async function stitchMultiple(clips, outputPath) {
  // Calculate per-segment timing data
  const segments = clips.map((clip, i) => {
    const nextClip = clips[i + 1];
    // Slot = time until next segment starts (or clip's own duration for last segment)
    const slotDuration = nextClip
      ? nextClip.startSec - clip.startSec
      : clip.durationSec; // last clip: no padding needed

    const gapDuration = Math.max(0, slotDuration - clip.durationSec);
    const tempo = clip.durationSec > slotDuration && slotDuration > 0
      ? Math.min(clip.durationSec / slotDuration, MAX_TEMPO)
      : 1.0;

    // Effective clip duration after tempo adjustment
    const effectiveDuration = clip.durationSec / tempo;
    const effectiveGap = Math.max(0, slotDuration - effectiveDuration);

    return {
      ...clip,
      slotDuration,
      gapDuration,
      tempo,
      effectiveDuration,
      effectiveGap,
    };
  });

  // Log timing summary for debugging
  logTimingSummary(segments);

  // We stitch by creating a concat list: each segment is processed individually
  // then joined. For complex filter graphs with many inputs, ffmpeg has arg limits,
  // so we use a segment-by-segment approach with intermediate files.
  const intermediates = await buildIntermediates(segments);

  try {
    await concatenateIntermediates(intermediates, outputPath);
  } finally {
    // Clean up intermediate files
    await Promise.all(
      intermediates.map(f => unlink(f).catch(() => {}))
    );
  }
}

/**
 * For each segment: create a "padded clip" MP3 = tempo-adjusted clip + silence.
 * This is the padded clip that exactly fills the segment's time slot.
 */
async function buildIntermediates(segments) {
  const intermediatePaths = [];

  for (const seg of segments) {
    const intermediatePath = seg.filePath.replace('.mp3', '-padded.mp3');
    intermediatePaths.push(intermediatePath);

    await buildPaddedClip(seg, intermediatePath);
  }

  return intermediatePaths;
}

function buildPaddedClip(seg, outputPath) {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg();

    // Input: the TTS clip
    cmd.input(seg.filePath);

    const filterParts = [];
    let lastOutput = '0:a';

    // Apply tempo adjustment if needed
    if (seg.tempo > 1.001) { // Only if meaningfully different from 1.0
      // atempo filter supports 0.5-100.0 range
      // For values > 2.0, chain multiple filters: atempo=2.0,atempo=X
      const atempoFilters = buildAtempoChain(seg.tempo);
      filterParts.push(`[${lastOutput}]${atempoFilters}[clipped]`);
      lastOutput = 'clipped';
    }

    // Add silence padding if there's a gap after this clip
    if (seg.effectiveGap > 0.05) { // Only pad if gap > 50ms
      // aevalsrc=0 generates digital silence; d= specifies duration
      filterParts.push(
        `aevalsrc=0:d=${seg.effectiveGap.toFixed(3)}:s=${SAMPLE_RATE}:c=mono[silence]`
      );
      filterParts.push(`[${lastOutput}][silence]concat=n=2:v=0:a=1[out]`);
      lastOutput = 'out';
    } else {
      // No padding needed — just rename the output label
      if (lastOutput !== 'out') {
        // If no tempo filter was applied either, do a passthrough
        if (filterParts.length === 0) {
          // No filters needed at all — just copy the file
          return ffmpeg(seg.filePath)
            .audioBitrate(AUDIO_BITRATE)
            .audioFrequency(SAMPLE_RATE)
            .audioChannels(1)
            .save(outputPath)
            .on('end', resolve)
            .on('error', err => reject(new Error(`Passthrough failed: ${err.message}`)));
        }
        filterParts.push(`[${lastOutput}]acopy[out]`);
        lastOutput = 'out';
      }
    }

    cmd
      .complexFilter(filterParts)
      .outputOptions(['-map', `[${lastOutput}]`])
      .audioBitrate(AUDIO_BITRATE)
      .audioFrequency(SAMPLE_RATE)
      .audioChannels(1)
      .save(outputPath)
      .on('end', resolve)
      .on('error', err => reject(new Error(`Padded clip build failed for segment ${seg.index}: ${err.message}`)));
  });
}

/**
 * Build an atempo filter chain string for the given tempo value.
 * atempo only accepts 0.5-100.0, so chain for extreme values.
 * In practice our cap of 1.35 always fits in a single atempo call.
 */
function buildAtempoChain(tempo) {
  if (tempo <= 100.0) {
    return `atempo=${tempo.toFixed(4)}`;
  }
  // Theoretical multi-chain for extreme tempos (won't be hit with 1.35 cap)
  const chain = [];
  let remaining = tempo;
  while (remaining > 100.0) {
    chain.push('atempo=100.0');
    remaining /= 100.0;
  }
  chain.push(`atempo=${remaining.toFixed(4)}`);
  return chain.join(',');
}

/**
 * Concatenate all intermediate padded-clip files into the final output.
 * Uses ffmpeg concat demuxer (stream copy = no re-encoding, very fast).
 */
async function concatenateIntermediates(intermediatePaths, outputPath) {
  // Write a concat list file for ffmpeg's concat demuxer
  const concatListPath = outputPath.replace('.mp3', '-concat-list.txt');
  const listContent = intermediatePaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`) // escape single quotes
    .join('\n');

  await writeFile(concatListPath, listContent, 'utf-8');

  try {
    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(concatListPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .outputOptions(['-c:a', 'copy']) // stream copy — no re-encoding
        .save(outputPath)
        .on('end', resolve)
        .on('error', err => reject(new Error(`Concatenation failed: ${err.message}`)));
    });
  } finally {
    await unlink(concatListPath).catch(() => {});
  }
}

// ─── Logging ─────────────────────────────────────────────────────────────────

function logTimingSummary(segments) {
  let overruns = 0;
  let tempoAdjusted = 0;

  for (const seg of segments) {
    if (seg.tempo > 1.001) tempoAdjusted++;
    if (seg.effectiveDuration > seg.slotDuration + 0.1) overruns++;
  }

  console.log(`[stitcher] ${segments.length} segments:`);
  console.log(`  Tempo-adjusted: ${tempoAdjusted}/${segments.length}`);
  console.log(`  Overruns (capped at ${MAX_TEMPO}x): ${overruns}/${segments.length}`);

  // Log worst offenders
  const worst = [...segments]
    .filter(s => s.tempo > 1.001)
    .sort((a, b) => b.tempo - a.tempo)
    .slice(0, 5);

  if (worst.length > 0) {
    console.log(`  Worst tempo adjustments:`);
    worst.forEach(s => {
      const applied = Math.min(s.tempo, MAX_TEMPO);
      console.log(
        `    Seg ${s.index} @${s.startSec.toFixed(1)}s: ` +
        `${s.durationSec.toFixed(2)}s clip → ${s.slotDuration.toFixed(2)}s slot ` +
        `(${applied.toFixed(2)}x${s.tempo > MAX_TEMPO ? ' ⚠ capped' : ''})`
      );
    });
  }
}
