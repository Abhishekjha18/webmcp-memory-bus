/**
 * Relays tool calls into the bridge frame and returns its answers.
 *
 * The bridge only accepts messages from chrome-extension:// origins, so this
 * document is the sole path into the store — a website cannot frame the
 * bridge and drive it itself.
 */
const BRIDGE_ORIGIN = "https://abhishekjha18.github.io";
const CHANNEL = "agent-memory-bus";

const frame = document.getElementById("bridge");
let nextId = 0;
const pending = new Map();
let ready = false;
const readyWaiters = [];

window.addEventListener("message", (event) => {
  const msg = event.data;
  if (event.origin !== BRIDGE_ORIGIN || !msg || msg.channel !== CHANNEL) return;

  if (msg.ready) {
    ready = true;
    while (readyWaiters.length) readyWaiters.shift()();
    return;
  }

  const entry = pending.get(msg.id);
  if (!entry) return;
  pending.delete(msg.id);
  entry({ result: msg.result, error: msg.error });
});

function whenReady() {
  if (ready) return Promise.resolve();
  return new Promise((resolve) => {
    readyWaiters.push(resolve);
    // The frame may already have loaded and posted before this listener ran.
    setTimeout(resolve, 5000);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "memory-bus-offscreen") return;

  (async () => {
    await whenReady();
    const id = ++nextId;
    const timer = setTimeout(() => {
      if (pending.delete(id)) sendResponse({ error: "memory bridge timed out" });
    }, 25000);

    pending.set(id, (payload) => {
      clearTimeout(timer);
      sendResponse(payload);
    });

    frame.contentWindow.postMessage(
      { channel: CHANNEL, id, tool: message.tool, args: message.args },
      BRIDGE_ORIGIN,
    );
  })();

  return true;
});
