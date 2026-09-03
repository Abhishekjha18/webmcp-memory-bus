# Tool reference

Five tools are registered on `document.modelContext` (falling back to
`navigator.modelContext`) when the page loads in a WebMCP-capable browser.

All five are defined in one place — `TOOL_SPECS` in `src/lib/webmcpTools.js` —
so the schema, annotations and handler for a tool cannot drift apart.

## Annotations at a glance

| Tool | `readOnlyHint` | `untrustedContentHint` |
|---|---|---|
| `store_observation` | `false` | `false` |
| `retrieve_relevant` | `true` | `true` |
| `get_working_memory` | `true` | `true` |
| `link_concepts` | `false` | `false` |
| `summarize_context` | `true` | `true` |

`untrustedContentHint` is set on exactly the tools whose output can replay text
the calling agent did not write. See [SECURITY.md](SECURITY.md).

No tool declares `exposedTo`. These mutate the user's own memory store; the
default audience — an agent interacting with this page — is the intended one.

---

## `store_observation`

Record something read, decided, or noticed.

| Param | Type | Required | Notes |
|---|---|---|---|
| `content` | string | yes | The observation text. |
| `source_url` | string | no | Where it came from. Stored as `null` if omitted. |
| `timestamp` | string | no | ISO 8601. Defaults to now. Accepts backdating. |
| `tags` | string[] | no | Free-form topic tags. Defaults to `[]`. |

Returns the stored record, including its assigned `id` and a `flagged` boolean.

Hidden codepoints are stripped from `content` and `tags` before storage.
Injection-shaped text is **flagged, not altered** — see
[SECURITY.md](SECURITY.md#1-indirect-prompt-injection).

Throws `content is required and must be a string` on missing, empty, or
non-string content.

---

## `retrieve_relevant`

Semantic similarity search over stored observations.

| Param | Type | Required | Notes |
|---|---|---|---|
| `query` | string | yes | What to search for. |
| `task_context` | string | no | Appended to the query before embedding, to bias results toward the current task. |
| `limit` | number | no | Default 5, hard-capped at 20. |

Returns an array sorted by descending `score` (cosine similarity, 0–1). Each
result carries the observation's fields plus `score`; `embedding` is stripped and
`content` is wrapped in `<untrusted-user-content>` and truncated at 240 chars.

Returns `[]` on an empty store. Throws `query is required and must be a string`
if `query` is missing.

---

## `get_working_memory`

Relevant *and* recent observations for what is happening right now.

| Param | Type | Required | Notes |
|---|---|---|---|
| `current_task` | string | yes | What the caller is working on. |
| `limit` | number | no | Default 5, hard-capped at 20. |

Returns results carrying both `similarity` (pure cosine) and `score` (recency
blended), so a caller can see how much recency moved a result. The recency
half-life is 72 hours; see [ARCHITECTURE.md](ARCHITECTURE.md#ranking) for the
formula and why the weight floors at 0.7 rather than decaying to zero.

Use this over `retrieve_relevant` when "what was I just doing" matters. Use
`retrieve_relevant` when the age of a memory is irrelevant.

---

## `link_concepts`

Record an edge in the semantic graph.

| Param | Type | Required | Notes |
|---|---|---|---|
| `entity1` | string | yes | Subject. |
| `entity2` | string | yes | Object. |
| `relation` | string | yes | e.g. `causes`, `is a`, `blocks`. |
| `confidence` | number | no | 0–1. Defaults to 1. |

Both entity names are upserted into the `concepts` store and the edge is written
to `relations`, in a single transaction across both stores — a partially written
edge with a missing node is not possible. Repeating an entity name does not
duplicate the node.

Throws `entity1, entity2, and relation are required` if any is missing.

---

## `summarize_context`

Filtered digest of observations plus concept links, for the caller to summarize.
This tool deliberately does not summarize anything itself — it gathers, the
agent writes.

| Param | Type | Required | Notes |
|---|---|---|---|
| `time_range.start` | string | no | ISO 8601, inclusive. |
| `time_range.end` | string | no | ISO 8601, inclusive. |
| `topic_filter` | string | no | Case-insensitive substring, matched against `content` and each tag. |

Returns:

```js
{
  observation_count,        // total matches, before the 20-item slice
  observations,             // newest first, max 20, content shielded
  related_concept_links,    // max 20
}
```

`observation_count` is the count *before* truncation, so a caller can tell that
more matched than were returned. Either bound of `time_range` may be given
alone. Filters combine with AND.

---

## Text budgets

Chrome's provisional limits, enforced by `checkToolBudgets()` and asserted in
`src/lib/webmcpTools.test.js`:

| Field | Limit | Current worst case |
|---|---|---|
| tool name | 30 | 18 (`get_working_memory`) |
| tool description | 500 | 183 (`summarize_context`) |
| parameter description | 150 | 64 (`link_concepts.relation`) |
| output | ~1500 | capped by a 240-char per-observation truncation and a 20-result limit |

A violation warns to the console at registration and fails the test suite.
