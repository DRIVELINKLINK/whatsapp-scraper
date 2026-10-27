// Isolated world: forwards data from the page script (main.js) to the background worker.
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data || e.data.__wahub !== true) return;
  try {
    chrome.runtime.sendMessage({ kind: e.data.kind, payload: e.data.payload }, () => {
      void chrome.runtime.lastError; // ignore "no receiver" while the worker wakes up
    });
  } catch (_) {
    // Extension was reloaded; this page needs a refresh to reconnect.
  }
});
