document.addEventListener('DOMContentLoaded', async () => {
  const statusContainer = document.getElementById('status-container');
  const statusText = document.getElementById('status-text');
  const errorMessage = document.getElementById('error-message');
  const actionBtn = document.getElementById('action-btn');

  function updateUI(state, text, error = null) {
    statusContainer.className = `status-container ${state}`;
    statusText.textContent = text;
    if (error) {
      errorMessage.textContent = error;
      errorMessage.style.display = 'block';
    } else {
      errorMessage.style.display = 'none';
    }

    if (state === 'processing') {
      actionBtn.disabled = true;
      actionBtn.textContent = 'Processing...';
    } else if (state === 'ready') {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Stop Dubbing';
    } else if (state === 'idle' || state === 'error') {
      actionBtn.disabled = false;
      actionBtn.textContent = 'Dub this video';
    }
  }

  // Get current tab state
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  
  if (!tab.url || !tab.url.includes('youtube.com/watch')) {
    updateUI('error', 'Not a YouTube video', 'Please navigate to a YouTube video page to use this extension.');
    actionBtn.disabled = true;
    return;
  }

  // Request current status from content script
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if (response) {
      updateUI(response.state, response.text, response.error);
    } else {
      updateUI('idle', 'Ready to dub');
    }
  } catch (err) {
    // Content script might not be injected yet or no active job
    updateUI('idle', 'Ready to dub');
  }

  actionBtn.addEventListener('click', async () => {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
      
      if (response && response.state === 'ready') {
        // Stop current dubbing
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_DUBBING' });
        updateUI('idle', 'Ready to dub');
      } else {
        // Start dubbing
        updateUI('processing', 'Initializing...');
        await chrome.tabs.sendMessage(tab.id, { type: 'START_DUBBING' });
        // Start polling popup UI updates
        pollState(tab.id);
      }
    } catch (err) {
      console.error('Error talking to content script:', err);
      // Attempt to inject content script if not there
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        });
        updateUI('processing', 'Initializing...');
        await chrome.tabs.sendMessage(tab.id, { type: 'START_DUBBING' });
        pollState(tab.id);
      } catch (e) {
         updateUI('error', 'Failed to start', 'Refresh the page and try again.');
      }
    }
  });
  
  let pollInterval;
  function pollState(tabId) {
    clearInterval(pollInterval);
    pollInterval = setInterval(async () => {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_STATE' });
        if (response) {
          updateUI(response.state, response.text, response.error);
          if (response.state !== 'processing') {
             clearInterval(pollInterval);
          }
        }
      } catch(e) {
        clearInterval(pollInterval);
      }
    }, 1000);
  }
  
  // Initial poll setup if processing
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { type: 'GET_STATE' });
    if(res && res.state === 'processing') {
       pollState(tab.id);
    }
  } catch(e) {}
});
