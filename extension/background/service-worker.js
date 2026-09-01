// service-worker.js
// Minimal background script for Manifest V3

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log("YouTube Hindi Dubber extension installed.");
});

// We could manage global state here if needed across multiple tabs,
// but for V1, content script + popup messaging is sufficient.
