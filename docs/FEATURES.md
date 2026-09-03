# Features, and what they actually do

## Built and working

**Persistent episodic memory.** `store_observation` writes text, source URL,
timestamp and tags to IndexedDB. Survives reload, tab close, and browser
restart. Timestamps can be backdated, so an agent can record when something was
observed rather than when it got around to storing it.

**Local semantic search.** `retrieve_relevant` embeds the query with
`Xenova/all-MiniLM-L6-v2` running in the tab and ranks by cosine similarity.
No embedding API, no network call per query, no text leaves the machine.

**Recency-weighted working memory.** `get_working_memory` blends similarity with
an exponential recency decay (72-hour half-life, weight floored at 0.7) so
"what was I just doing" outranks an equally relevant note from last year,
without burying old but highly relevant memories.

**Semantic concept graph.** `link_concepts` records typed, confidence-scored
edges between entities in a store separate from the episodic log. Nodes are
upserted; edge and both nodes are written in one transaction.

**Filtered digests.** `summarize_context` filters by time range and/or topic and
returns matching observations plus concept links, reporting the true match count
even when the returned list is truncated.

**Injection defenses.** Hidden codepoints stripped at write time, injection
signatures flagged and surfaced in the UI, retrieved content wrapped in
`<untrusted-user-content>`, output length and result count capped, and
`untrustedContentHint` declared on every tool that replays stored text. Full
detail and honest limits in [SECURITY.md](SECURITY.md).

**Works without an agent.** The UI is not a demo shell around the tools — it
calls `memoryStore` directly. Store, search, browse and clear all work in a
browser with no WebMCP support at all, which is also how the app is testable.

**Live tool activity log.** Every tool invocation is timed and logged with its
arguments and result or error, rendered in the UI. Useful for watching an agent
actually use the store, and the reason a failing tool call is diagnosable at all.

**89 unit tests** across sanitization, store logic and the tool layer, gating
deploy in CI.

---

## Honest limitations

**Tools are tab-scoped, not ambient.** WebMCP scopes registered tools to the tab
that registered them. An agent cannot reach this memory from some other site's
tab; it has to actually be working with this page. The intended pattern is that
an agent visits this page as its memory tool mid-task, calls what it needs, and
continues elsewhere. If you expected a background memory service every tab can
call, this is not that, and the spec does not currently allow that.

**Real cross-process WebMCP invocation is not verified.** The tool layer is
tested against a mocked `modelContext` and driven end-to-end through a headless
browser, which exercises every line of the same code paths. What has *not* been
exercised is Chrome's actual agent IPC delivering a call from a real model,
because that requires a flag-enabled browser with an agent attached. The
`document.modelContext`-first resolution order is written to match the current
spec surface but is likewise unverified against a live build.

**No cap on stored volume, no eviction.** Retrieval is a linear scan over every
stored observation. At a few thousand records this will be visibly slow, and
nothing prunes old memories. There is no pagination, archival, or index beyond
IndexedDB's own.

**Embedding quality is MiniLM-quality.** A 6-layer, 384-dimension model chosen
to be small enough to ship to a browser. It handles paraphrase and topical
similarity well; it does not handle negation, numeric reasoning, or long
documents well. Observations are embedded whole, so a long observation gets one
averaged vector and retrieves fuzzily.

**First load is slow.** ~25MB of WASM and model weights download before the
first embedding resolves. Cached thereafter, but the first store or search on a
cold profile takes noticeably long. There is a progress callback plumbed through
`embeddings.js` but the UI does not currently surface a progress bar.

**No multi-user or multi-device story.** Memory is per-origin, per-browser
profile. No sync, no export, no import, no accounts. Clearing site data destroys
everything with no backup.

**No editing or per-item deletion.** An observation can be stored and everything
can be cleared. There is no way to fix a typo, delete one planted memory, or
remove a single bad concept edge — which is a real gap given that flagging
injected content is only useful if you can then act on it.

**Concept graph is recorded, not reasoned over.** `link_concepts` stores edges
and `summarize_context` returns them, but nothing traverses the graph. There is
no multi-hop query, no path finding, no inference. The semantic half of the
"dual-graph" design is currently a well-structured record rather than an active
retrieval mechanism.
