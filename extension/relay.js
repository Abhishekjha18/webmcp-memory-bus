/**
 * Isolated-world half of the content script.
 *
 * The MAIN-world script can reach `document.modelContext` but has no chrome.*
 * APIs; this half has chrome.* but cannot see page JS. Together they carry a
 * tool call from the page to the service worker and back.
 */
const CHANNEL = "agent-memory-bus-page";

window.addEventListener("message", async (event) => {
  const msg = event.data;
  if (event.source !== window || !msg || msg.channel !== CHANNEL || msg.isReply) return;

  const reply = (payload) =>
    window.postMessage({ channel: CHANNEL, id: msg.id, isReply: true, ...payload }, "*");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "memory-bus-call",
      tool: msg.tool,
      args: msg.args,
    });
    reply(response?.error ? { error: response.error } : { result: response?.result });
  } catch (err) {
    // Usually means the service worker was replaced mid-call (extension
    // reloaded); surface it rather than leaving the agent's promise hanging.
    reply({ error: err instanceof Error ? err.message : String(err) });
  }
});
