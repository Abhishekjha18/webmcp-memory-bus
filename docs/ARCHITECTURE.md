# Architecture

Agent Memory Bus is a single-page React app with no backend. Every layer —
storage, embedding, ranking, tool exposure — runs in the browser tab.

```
                    ┌─────────────────────────────────────┐
   browser agent    │  document.modelContext              │
   (Chrome, flag)   │    .registerTool() x6               │
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
joined only at summarization time, and — via `explore_concepts` — at traversal
time: each hop of a graph walk is one indexed lookup per frontier node against
`entity1`/`entity2`, rather than a scan of the whole `relations` store.

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

**`App.jsx`** — renders the five cards and calls `memoryStore` directly for the
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

`retrieve_relevant` is pure cosine similarity — no recency, no provenance, no
supersede penalty. It exists for "find the closest match to this meaning,"
and blending in anything else would make that contract harder to reason
about. A superseded observation is still returned by it at full similarity;
`supersededBy` is present in the result for a caller that wants to check.

`get_working_memory` blends in recency, provenance, and superseding — the
first two as bounded multiplicative floors, so each factor's maximum
possible influence is a fixed, statable percentage; the third as a flat
penalty, since it is not a preference dimension at all but a correctness
one — a retracted fact should almost never win:

```js
recencyWeight     = 0.5 ** (ageHours / 72)             // 72h half-life
provenanceWeight  = author === "human" ? 1 : 0
supersededPenalty = supersededBy != null ? 0.15 : 1
score             = similarity
                  * (0.7  + 0.3  * recencyWeight)      // up to ±30%
                  * (0.95 + 0.05 * provenanceWeight)    // up to ±5%
                  * supersededPenalty                   // flat 85% cut
```

The `0.7 +` floor is the load-bearing part of recency: it can lift a result by
at most ~43% relative to its floor, and can never drive a highly relevant old
memory to zero. A pure multiplicative decay would make the store amnesic about
anything from last month regardless of how relevant it is. Future timestamps
clamp to age zero rather than scoring above 1.

Provenance gets a deliberately smaller band than recency — half the swing.
Recency is a strong, well-established signal that something is still
relevant; authorship is a weaker signal about how much to *trust* a memory,
not how relevant it is. A 5% nudge breaks a near-tie in favor of something the
user typed themselves without letting it override a genuine relevance gap —
a barely-relevant human note still loses to a highly relevant agent-recorded
one. See
[SECURITY.md](SECURITY.md#6-provenance-and-the-humanagent-trust-boundary) for
why `author` cannot be supplied by the caller in the first place.

Superseding is deliberately not a bounded floor like the other two, because
it is not answering "how relevant" or "how much to trust" — it is answering
"is this still true." A flat multiplier says so plainly: 0.15, not a range
that could still be argued about. The record is never deleted or hidden by
this, only outranked; see
[SECURITY.md](SECURITY.md#7-superseding-and-the-stealth-suppression-risk-it-opens)
for why the write path that sets `supersededBy` is restricted the same way
deletion is.

## Graph traversal

`explore_concepts` is a breadth-first walk outward from one entity, capped at
4 hops and 15 nodes so a dense graph still returns a quick glance rather than
a dump. Two design choices worth naming:

- **No structural link between an observation and a concept node.** The
  episodic and semantic stores were designed independently, so traversal
  bridges them through the one field they already share: an observation
  tagged `postgres` is treated as being about the concept node `postgres`.
  This means a graph walk can only surface observations someone bothered to
  tag — it is a real but incomplete bridge, not a foreign key.
- **Concept-name resolution is case-insensitive on a miss.** Concepts are
  free text typed by agents and humans, so an exact index lookup is tried
  first and a full scan of the (small) `concepts` store is the fallback,
  rather than normalizing case at write time and losing the original casing.

## Registration lifecycle

WebMCP has no `unregisterTool`. An `AbortSignal` is the only documented way to
take a tool back down, so `App.jsx` creates an `AbortController` in its mount
effect and aborts it on cleanup. Without this, React 19 StrictMode's dev-mode
double-invoke would register two copies of all six tools.

`getModelContext()` checks `document.modelContext` first and falls back to
`navigator.modelContext`. Chrome is mid-migration between the two names; a build
exposing both must get tools registered on the current surface.
