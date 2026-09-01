/**
 * tts.js
 *
 * Generates Hindi audio clips for each translated segment using
 * Azure Cognitive Services Speech SDK.
 *
 * Uses p-limit for bounded concurrency (default 8 parallel requests).
 * Each clip's actual duration is measured via ffprobe for use by the stitcher.
 */

import * as sdk from 'microsoft-cognitiveservices-speech-sdk';
import { join } from 'path';
import pLimit from 'p-limit';
import ffmpeg from 'fluent-ffmpeg';

const CONCURRENCY = parseInt(process.env.TTS_CONCURRENCY || '8', 10);

/**
 * @param {Array<{startSec: number, endSec: number, text: string}>} segments
 *   Hindi-translated segments to synthesize
 * @param {string} outputDir  Directory to write segment MP3 files
 * @returns {Promise<Array<{index: number, startSec: number, endSec: number, filePath: string, durationSec: number}>>}
 *   Sorted by index, with actual audio duration measured.
 */
export async function synthesizeSegments(segments, outputDir) {
  const limit = pLimit(CONCURRENCY);

  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  if (!key || !region) {
    throw new Error('Azure Speech credentials not configured in .env');
  }

  const speechConfig = sdk.SpeechConfig.fromSubscription(key, region);
  speechConfig.speechSynthesisVoiceName = 'hi-IN-MadhurNeural';
  speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Audio24Khz96KBitRateMonoMp3;

  const tasks = segments.map((segment, index) =>
    limit(() => synthesizeOne(speechConfig, segment, index, outputDir))
  );

  // Run all tasks with bounded concurrency, preserving order
  const results = await Promise.all(tasks);

  // Sort by index just in case
  return results.sort((a, b) => a.index - b.index);
}

function synthesizeOne(speechConfig, segment, index, outputDir) {
  return new Promise((resolve, reject) => {
    const filePath = join(outputDir, `segment-${String(index).padStart(4, '0')}.mp3`);
    const audioConfig = sdk.AudioConfig.fromAudioFileOutput(filePath);
    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, audioConfig);

    synthesizer.speakTextAsync(
      segment.text,
      async (result) => {
        synthesizer.close();
        
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          try {
            // Measure actual audio duration
            const durationSec = await getAudioDuration(filePath);
            
            resolve({
              index,
              startSec: segment.startSec,
              endSec: segment.endSec,
              filePath,
              durationSec,
            });
          } catch (err) {
            reject(err);
          }
        } else {
          reject(new Error("Speech synthesis failed: " + result.errorDetails));
        }
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

/**
 * Use ffprobe to measure the actual duration of an audio file.
 * @param {string} filePath
 * @returns {Promise<number>} Duration in seconds
 */
function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) {
        reject(new Error(`ffprobe failed for ${filePath}: ${err.message}`));
        return;
      }
      const duration = metadata?.format?.duration;
      if (typeof duration !== 'number' || isNaN(duration)) {
        reject(new Error(`Could not read duration from ${filePath}`));
        return;
      }
      resolve(duration);
    });
  });
}
