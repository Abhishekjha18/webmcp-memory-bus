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

**Graph traversal.** `explore_concepts` walks the graph breadth-first from a
named entity, using the `entity1`/`entity2` indexes directly, and bridges into
the episodic store through matching tags — "what do I know that's connected to
Postgres" surfaces both graph edges and tagged observations, including ones
that share no vocabulary with the query. This is what makes the graph load-
bearing rather than a flat, unused list of edges.

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

**Human-only deletion.** Every observation and concept link has a delete control,
and Clear all confirms before wiping. No agent tool can delete anything, so a
planted memory cannot talk an agent into erasing the real ones — see
[SECURITY.md](SECURITY.md#1-indirect-prompt-injection).

**Export and import.** The whole store round-trips as a JSON file, so memory is
portable across browsers and machines and survives clearing site data. Imports
are treated as untrusted input: records are re-sanitized and re-flagged, and
appended rather than overwriting.

**Live tool activity log.** Every tool invocation is timed and logged with its
arguments and result or error, rendered in the UI. Useful for watching an agent
actually use the store, and the reason a failing tool call is diagnosable at all.

**140 unit tests** across sanitization, store logic, graph traversal and the
tool layer, plus a real-stack integration suite (12/12) that exercises the
actual embedding model and IndexedDB rather than mocks, gating deploy in CI.

---

## Honest limitations

**Tools are tab-scoped by default; the extension is opt-in.** WebMCP scopes
registered tools to the tab that registered them, so out of the box an agent
has to actually be working with this page to reach the memory. The optional
companion extension (`extension/`) removes that limit by registering the same
tools on every page — see [ARCHITECTURE.md](ARCHITECTURE.md) and
`extension/README.md` — but it is a separate install, not something the live
URL alone provides. A judge who only opens the site sees the tab-scoped
behavior; the ambient behavior requires loading the unpacked extension too.

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
first embedding resolves. A progress bar reports the aggregate percentage while
it happens, and it is cached afterwards, but the first store or search on a cold
profile still takes noticeably long.

**No sync or accounts.** Memory is per-origin, per-browser profile. Moving it
between browsers or machines is a manual export/import, not sync, and there is
no merge or conflict resolution — an import appends.

**No editing.** An observation can be stored and deleted, but not amended. Fixing
a typo means deleting and re-storing, which loses the original timestamp.

**Graph traversal is breadth-first, not weighted or typed.** `explore_concepts`
walks outward by hop count alone — a `confidence: 0.1` edge and a `confidence: 1`
edge count the same, and `relation` is never used to prefer one path over
another (a `contradicts` edge is followed exactly like a `causes` edge). There
is no path-finding between two named entities, only outward expansion from one.
