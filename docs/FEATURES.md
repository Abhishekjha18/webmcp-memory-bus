# Features, and what they actually do

## Built and working

**Persistent episodic memory.** `store_observation` writes text, source URL,
timestamp and tags to IndexedDB. Survives reload, tab close, and browser
restart. Timestamps can be backdated, so an agent can record when something was
observed rather than when it got around to storing it.

**Local semantic search.** `retrieve_relevant` embeds the query with
`Xenova/all-MiniLM-L6-v2` running in the tab and ranks by cosine similarity.
No embedding API, no network call per query, no text leaves the machine.

**Recency-, provenance- and supersede-weighted working memory.**
`get_working_memory` blends similarity with an exponential recency decay
(72-hour half-life, floored at 0.7) so "what was I just doing" outranks an
equally relevant note from last year, a smaller provenance nudge (floored at
0.95) that breaks a near-tie in favor of something the user typed themselves,
and a flat 0.15× cut for anything marked superseded. Recency and provenance
can't bury a genuinely more relevant memory — both are bounded floors, not
overrides — but the supersede cut is deliberately not bounded that way,
since it isn't a preference, it's a correctness signal that a fact has been
retracted.

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

**Provenance.** Every observation is tagged `human`, `agent`, or `imported`
depending on which boundary actually wrote it, shown as a badge in the UI.
`get_working_memory` gives human-authored memories a small ranking edge — a
tie-breaker, not an override. The field cannot be forged: an agent including
`author: "human"` in a tool call is overridden at the boundary, and an import
file's claimed authorship is discarded in favor of `imported`, unconditionally.

**Superseding.** A new observation can retire an older one by id
(`store_observation`'s `supersedes` parameter, or the ↻ button in the UI).
The old record is never deleted — it stays in the list, struck through and
badged `superseded`, for audit — but `get_working_memory` cuts its score by
85%. Generalizes "agents write, only humans erase": an agent-authored call
cannot supersede a human-authored memory, only another human-authored one
can. It does not generalize the other direction — one agent-sourced memory
can still supersede another unchecked, a disclosed, not fully closed, gap.
See [SECURITY.md](SECURITY.md#7-superseding-and-the-stealth-suppression-risk-it-opens).

**Write-time deduplication.** Storing an exact repeat — same text after
case/whitespace/punctuation normalization, same author, within 5 minutes —
merges into the existing observation instead of creating a new one,
bumping its timestamp and unioning its tags. Fixes an agent stuck in a
loop filling the store with copies of the same fact, and re-importing an
already-present backup file, in one mechanism. Deliberately text-based,
not embedding-based: a similarity-threshold version was tried, measured
against real content, and found to misclassify distinct short
observations as duplicates at a real, non-negligible rate — see
[SECURITY.md §8](SECURITY.md#8-write-time-deduplication-a-design-pivot-not-a-tuning-choice)
for the actual numbers.

**Tag-scoped retrieval.** `retrieve_relevant` and `get_working_memory` both
take an optional `tags` array, narrowing the search to observations
carrying at least one of them before ranking. Case-insensitive, matches
any (not all) of the requested tags, and a missing or malformed value is
treated as no filter rather than an error.

**Storage usage, visible.** The footer shows an approximate usage/quota
figure from `navigator.storage.estimate()`, refreshed alongside every
other view of the store. Degrades to showing nothing — not an error — on
a browser that lacks the API.

**Export and import.** The whole store round-trips as a JSON file, so memory is
portable across browsers and machines and survives clearing site data. Imports
are treated as untrusted input: records are re-sanitized and re-flagged, and
appended rather than overwriting.

**Live tool activity log.** Every tool invocation is timed and logged with its
arguments and result or error, rendered in the UI. Useful for watching an agent
actually use the store, and the reason a failing tool call is diagnosable at all.

**194 unit tests** across sanitization, store logic, graph traversal and the
tool layer, plus a real-stack integration suite (17/17) that exercises the
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
spec surface but is likewise unverified against a live build. The same caveat
applies more strongly to the extension: `extension-parity.test.js` confirms its
duplicated tool declarations match the site's, but no automated test in this
repo has loaded it as an actual unpacked extension in Chrome — its
`register-tools.js` → `background.js`/`offscreen.js` → `bridge.html` relay path
is verified by code review and by the fact that it calls the same, already
heavily-tested `memoryStore`/`webmcpTools` functions, not by an end-to-end run.

**No cap on stored volume, no eviction.** Retrieval is a linear scan over every
stored observation. At a few thousand records this will be visibly slow, and
nothing prunes old memories. There is no pagination, archival, or index beyond
IndexedDB's own. Write-time dedup narrows this — a literal repeat no longer
adds a row — but does nothing for a store full of genuinely distinct
observations, which is the actual growth case at any real scale. The
footer's storage estimate makes the growth visible; it doesn't slow it down.

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
