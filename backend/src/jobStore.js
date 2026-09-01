/**
 * In-memory job store for dubbing jobs.
 * Simple Map — sufficient for single-user local use (no Redis/Bull needed in V1).
 *
 * Job shape:
 * {
 *   jobId: string,
 *   videoId: string,
 *   status: 'processing' | 'ready' | 'error',
 *   error?: string,       // user-facing error message
 *   errorCode?: string,   // machine-readable: 'NO_CAPTIONS' | 'VIDEO_UNAVAILABLE' | 'YTDLP_ERROR' | 'PIPELINE_ERROR'
 *   audioPath?: string,   // absolute path to final audio file
 *   createdAt: Date,
 *   completedAt?: Date,
 * }
 */

const jobs = new Map();

export function createJob(jobId, videoId) {
  const job = {
    jobId,
    videoId,
    status: 'processing',
    createdAt: new Date(),
  };
  jobs.set(jobId, job);
  return job;
}

export function getJob(jobId) {
  return jobs.get(jobId) ?? null;
}

export function setJobReady(jobId, audioPath) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'ready';
  job.audioPath = audioPath;
  job.completedAt = new Date();
}

export function setJobError(jobId, errorCode, errorMessage) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = 'error';
  job.errorCode = errorCode;
  job.error = errorMessage;
  job.completedAt = new Date();
}

export function getAllJobs() {
  return Array.from(jobs.values());
}
