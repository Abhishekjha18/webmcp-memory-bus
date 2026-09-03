# Agent Memory Bus — ambient mode (companion extension)

WebMCP only offers an agent the tools registered by the page it is currently
on. That means the memory living at `abhishekjha18.github.io/webmcp-memory-bus`
is invisible from `github.com` — an agent helping you review a PR cannot reach
what you recorded yesterday unless you send it to the Memory Bus tab first.

This extension removes that limitation without changing what the standard
allows: it registers the same five tools on **every** page you visit, so
whatever page the agent is on already offers them.

## The store stays in one place

The extension holds no memory of its own. Every call is forwarded to
`bridge.html` on the app's origin, so reads and writes land in the **same**
IndexedDB the website's UI displays — one memory, visible and deletable in one
place, rather than an extension copy and a website copy that drift apart.

All sanitisation, injection flagging, untrusted-content envelopes and limit
clamping stay in the app's modules. The extension is transport only.

```
page (MAIN world)      register-tools.js   registers the 5 tools
      ↓ postMessage
content script         relay.js            has chrome.* APIs
      ↓ sendMessage
service worker         background.js       owns the offscreen document
      ↓ sendMessage
offscreen document     offscreen.js        frames the bridge
      ↓ postMessage
bridge.html (app origin)                   real store, real embeddings
```

The bridge is framed from an offscreen document rather than from the visited
page on purpose: a site's own Content-Security-Policy would refuse a
cross-origin frame, and sites with strict CSP are exactly where this needs to
work.

## Install (unpacked)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and select this `extension/` folder
4. Reload any tab you want ambient memory on

Requires Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled, the
same as the site.

## Verifying it works

1. Open any site — `github.com` is the interesting one
2. Open the Model Context Tool Inspector on that tab
3. The five memory tools should now be listed **on that page**, where before
   there were none
4. Execute `store_observation`; it is captured with that page's URL as its
   source
5. Open the Memory Bus site — the observation is there, in the same store

## Security boundary

`bridge.html` ignores any message that does not come from a
`chrome-extension://` origin, so a website cannot frame it and read or poison
your memory. Deletion is deliberately not exposed as a tool here either — as on
the site, clearing memory stays a human action.

## Known limits

- Unpacked installs get a fresh extension id; nothing depends on the id, but
  Chrome will ask you to re-enable developer mode after a restart.
- The bridge points at the deployed origin. To develop against a local dev
  server, change `BRIDGE_ORIGIN` in `offscreen.js`, the iframe `src` in
  `offscreen.html`, and `host_permissions` in `manifest.json`.
- Pages that load before the service worker wakes may need one reload.
