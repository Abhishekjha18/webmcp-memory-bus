/**
 * Service worker: owns the offscreen document that hosts the memory bridge.
 *
 * The bridge has to run on the app's own origin so it touches the same
 * IndexedDB the site's UI shows. Framing it from an offscreen document rather
 * than from the visited page matters: a page's own Content-Security-Policy
 * (github.com's, for instance) would refuse a cross-origin frame, which is
 * exactly where this feature needs to work.
 */
const OFFSCREEN_PATH = "offscreen.html";

let creating;

async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (existing.length > 0) return;

  // Concurrent tool calls must not race two createDocument calls.
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["IFRAME_SCRIPTING"],
        justification:
          "Hosts a same-origin frame of the Agent Memory Bus so tool calls reach its IndexedDB store.",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "memory-bus-call") return;

  (async () => {
    try {
      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({
        type: "memory-bus-offscreen",
        tool: message.tool,
        args: message.args,
      });
      sendResponse(response);
    } catch (err) {
      sendResponse({ error: err instanceof Error ? err.message : String(err) });
    }
  })();

  return true; // keep the channel open for the async reply
});
