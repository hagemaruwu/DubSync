// content.js
// Runs on youtube.com

const BACKEND_URL = 'http://localhost:3001';

let state = {
  status: 'idle', // idle, processing, ready, error
  text: 'Ready to dub',
  error: null,
  jobId: null,
  videoId: null
};

let audioContext = {
  element: null,
  videoElement: null,
  syncInterval: null,
  clockSkewInterval: null // secondary safety net for long videos
};

let pollInterval = null;

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_STATE') {
    sendResponse({
      state: state.status,
      text: state.text,
      error: state.error
    });
  } else if (message.type === 'START_DUBBING') {
    startDubbing();
    sendResponse({ success: true });
  } else if (message.type === 'STOP_DUBBING') {
    cleanup();
    sendResponse({ success: true });
  }
  return true;
});

function getVideoId() {
  const params = new URLSearchParams(window.location.search);
  return params.get('v');
}

function updateState(status, text, error = null) {
  state.status = status;
  state.text = text;
  state.error = error;
}

async function startDubbing() {
  const videoId = getVideoId();
  if (!videoId) {
    updateState('error', 'Error', 'No YouTube video ID found.');
    return;
  }
  
  if (state.videoId === videoId && state.status === 'processing') {
      return; // Already processing this video
  }

  cleanup(); // Clean up any previous state
  state.videoId = videoId;
  updateState('processing', 'Starting job...');

  try {
    const response = await fetch(`${BACKEND_URL}/dub`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId })
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || 'Failed to start job');
    }

    const data = await response.json();
    state.jobId = data.jobId;
    
    // Start polling
    startPolling();
    
  } catch (err) {
    console.error('Start dubbing error:', err);
    updateState('error', 'Failed to start', err.message);
  }
}

function startPolling() {
  clearInterval(pollInterval);
  updateState('processing', 'Fetching captions...');
  
  pollInterval = setInterval(async () => {
    try {
      const response = await fetch(`${BACKEND_URL}/dub/${state.jobId}/status`);
      if (!response.ok) throw new Error('Failed to get status');
      
      const data = await response.json();
      
      if (data.status === 'ready') {
        clearInterval(pollInterval);
        setupAudioPlayback();
      } else if (data.status === 'error') {
        clearInterval(pollInterval);
        // Map error codes to user-friendly messages
        let userMessage = data.error;
        if (data.errorCode === 'VIDEO_UNAVAILABLE') {
          userMessage = "Video is private, age-restricted, or unavailable.";
        } else if (data.errorCode === 'NO_CAPTIONS') {
          userMessage = "No English captions found for this video. Try a video with CC enabled.";
        } else if (data.errorCode === 'YTDLP_ERROR') {
          userMessage = `Caption fetching failed. Check that yt-dlp is up to date ('yt-dlp -U'). Details: ${data.error.substring(0, 100)}...`;
        }
        updateState('error', 'Error', userMessage);
      } else {
         // Keep processing, maybe update text based on time elapsed
         updateState('processing', 'Processing audio...');
      }
    } catch (err) {
      console.error('Polling error:', err);
      // Don't error out completely on a single failed poll, but maybe after a few
    }
  }, 3000); // Poll every 3 seconds
}

function setupAudioPlayback() {
  updateState('ready', 'Audio ready — playing');
  
  const video = document.querySelector('video');
  if (!video) {
    updateState('error', 'Playback error', 'Could not find video element on page.');
    return;
  }
  
  audioContext.videoElement = video;
  video.muted = true; // Mute original audio
  
  const audio = new Audio(`${BACKEND_URL}/dub/${state.jobId}/audio`);
  audioContext.element = audio;
  
  audio.load();
  
  // Wait for audio to be ready enough to play
  audio.addEventListener('canplay', () => {
     // Sync initial time
     audio.currentTime = video.currentTime;
     if (!video.paused) {
         audio.play().catch(e => console.error("Audio auto-play blocked", e));
     }
  });

  // Event-driven sync (no continuous polling interval for drift)
  
  // 1. Sync on Seek
  audioContext.onSeek = () => {
    audio.currentTime = video.currentTime;
  };
  video.addEventListener('seeked', audioContext.onSeek);
  
  // 2. Sync Play/Pause
  audioContext.onPlay = () => audio.play().catch(e => console.warn(e));
  audioContext.onPause = () => audio.pause();
  
  video.addEventListener('play', audioContext.onPlay);
  video.addEventListener('pause', audioContext.onPause);
  
  // 3. Sync Rate
  audioContext.onRateChange = () => {
    audio.playbackRate = video.playbackRate;
  };
  video.addEventListener('ratechange', audioContext.onRateChange);
  
  // 4. Secondary Safety Net: Clock Skew Watcher (every 10s, correct if drift > 1.5s)
  audioContext.clockSkewInterval = setInterval(() => {
    if (audio.paused || video.paused) return;
    const drift = Math.abs(audio.currentTime - video.currentTime);
    if (drift > 1.5) {
      console.log(`[Hindi Dubber] Clock skew detected (${drift.toFixed(2)}s). Resyncing...`);
      audio.currentTime = video.currentTime;
    }
  }, 10000);
  
  // Handle video ending
  audioContext.onEnded = () => {
     cleanup();
  };
  video.addEventListener('ended', audioContext.onEnded);
}

function cleanup() {
  clearInterval(pollInterval);
  if (audioContext.clockSkewInterval) {
    clearInterval(audioContext.clockSkewInterval);
    audioContext.clockSkewInterval = null;
  }
  
  if (audioContext.element) {
    audioContext.element.pause();
    audioContext.element.removeAttribute('src');
    audioContext.element.load();
    audioContext.element = null;
  }
  
  if (audioContext.videoElement) {
    // Remove listeners
    if(audioContext.onSeek) audioContext.videoElement.removeEventListener('seeked', audioContext.onSeek);
    if(audioContext.onPlay) audioContext.videoElement.removeEventListener('play', audioContext.onPlay);
    if(audioContext.onPause) audioContext.videoElement.removeEventListener('pause', audioContext.onPause);
    if(audioContext.onRateChange) audioContext.videoElement.removeEventListener('ratechange', audioContext.onRateChange);
    if(audioContext.onEnded) audioContext.videoElement.removeEventListener('ended', audioContext.onEnded);
    
    audioContext.videoElement.muted = false; // Unmute original
    audioContext.videoElement = null;
  }
  
  updateState('idle', 'Ready to dub', null);
  state.jobId = null;
}

// Handle YouTube SPA Navigation
window.addEventListener('yt-navigate-finish', () => {
  const newVideoId = getVideoId();
  if (state.videoId && newVideoId !== state.videoId) {
    // Navigated to a new video, clean up old dubbing
    cleanup();
  }
});
