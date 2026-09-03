# Architecture

Agent Memory Bus is a single-page React app with no backend. Every layer —
storage, embedding, ranking, tool exposure — runs in the browser tab.

```
                    ┌─────────────────────────────────────┐
   browser agent    │  document.modelContext              │
   (Chrome, flag)   │    .registerTool() x5               │
        │           └──────────────┬──────────────────────┘
        │ executeTool()            │
        ▼                          ▼
┌───────────────────────────────────────────────────────────┐
│  webmcpTools.js        tool specs, annotations, budgets    │
│                        wrap() -> activity log             │
│                        shield() -> untrusted envelope     │
└──────────────────────────────┬────────────────────────────┘
                               │            ▲
                               ▼            │ (unshielded, for display)
┌───────────────────────────────────────────────────────────┐
│  memoryStore.js        validation, sanitization, ranking   │──► App.jsx
└───────┬───────────────────────────────┬───────────────────┘
        │                               │
        ▼                               ▼
┌────────────────────┐        ┌──────────────────────────┐
│  embeddings.js     │        │  db.js  (idb wrapper)    │
│  transformers.js   │        │                          │
│  MiniLM-L6-v2      │        │  IndexedDB               │
│  local, in-browser │        │   observations           │
└────────────────────┘        │   concepts               │
                              │   relations              │
                              └──────────────────────────┘
```

## Layers

**`db.js`** — opens `agent-memory-bus` v1 via [`idb`](https://github.com/jakearchibald/idb)
and memoizes the connection promise. Three object stores:

| Store | Key | Indexes | Holds |
|---|---|---|---|
| `observations` | `id` (auto) | `timestamp`, `source_url` | episodic records + their embedding vector |
| `concepts` | `name` | — | semantic graph nodes (upserted) |
| `relations` | `id` (auto) | `entity1`, `entity2` | semantic graph edges |

This is the dual-graph shape: an **episodic** log of what was observed, and a
**semantic** graph of how entities relate. They are queried independently and
joined only at summarization time.

**`embeddings.js`** — lazily constructs a transformers.js `feature-extraction`
pipeline over `Xenova/all-MiniLM-L6-v2`. Output is mean-pooled and L2-normalized,
which is why `cosineSimilarity` is a bare dot product: for unit vectors the
normalization terms are 1. The model (~25MB of WASM plus weights) downloads once
and is then cached by the browser; the first embedding call after a cold load is
therefore slow, and every call after it is fast.

**`memoryStore.js`** — all business logic, and the only module that touches the
database. Responsibilities: input validation, sanitization at write time,
ranking at read time, and a `notify()` pub-sub so the UI re-renders when a tool
call mutates state. Returns plain data with embedding vectors stripped —
a 384-float array per record is useless to both the UI and an agent.

**`webmcpTools.js`** — the agent-facing boundary. Owns the tool specs,
annotations, budget checks, the activity log, and the untrusted-content
envelope.

**`App.jsx`** — renders the four panels and calls `memoryStore` directly for the
manual forms, so the UI is usable in a browser with no WebMCP support at all.

## Two important boundary decisions

**Shielding lives in `webmcpTools`, not `memoryStore`.** Retrieved content is
wrapped in `<untrusted-user-content>` only on the path to an agent. The UI reads
the same `memoryStore` functions and must show the human the actual text, not
envelope markup. Putting the wrap one layer lower would have leaked it into the
interface.

**Sanitization lives in `memoryStore`, not `webmcpTools`.** Hidden-codepoint
stripping happens at write time, once, before the text is embedded or persisted.
Doing it at read time would mean the stored text and the displayed text disagree,
and would re-do the work on every retrieval.

## Ranking

`retrieve_relevant` is pure cosine similarity.

`get_working_memory` blends in recency with an exponential half-life:

```js
recencyWeight = 0.5 ** (ageHours / 72)          // 72h half-life
score         = similarity * (0.7 + 0.3 * recencyWeight)
```

The `0.7 +` floor is the load-bearing part: recency can lift a result by at most
~43%, and can never drive a highly relevant old memory to zero. A pure
multiplicative decay would make the store amnesic about anything from last month
regardless of how relevant it is. Future timestamps clamp to age zero rather
than scoring above 1.

## Registration lifecycle

WebMCP has no `unregisterTool`. An `AbortSignal` is the only documented way to
take a tool back down, so `App.jsx` creates an `AbortController` in its mount
effect and aborts it on cleanup. Without this, React 19 StrictMode's dev-mode
double-invoke would register two copies of all five tools.

`getModelContext()` checks `document.modelContext` first and falls back to
`navigator.modelContext`. Chrome is mid-migration between the two names; a build
exposing both must get tools registered on the current surface.
