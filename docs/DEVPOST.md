# Agent Memory Bus — submission description

**Live app:** <https://abhishekjha18.github.io/webmcp-memory-bus/>
**Code:** <https://github.com/Abhishekjha18/webmcp-memory-bus>

No account, no API key, no authentication, nothing to install. Everything runs
client-side in the tab.

---

## What it is

Every agent conversation starts cold. You re-explain your stack, your
constraints, and the decision you made yesterday, every single time — while the
browser in front of you already holds all of it.

Agent Memory Bus is a WebMCP-enabled page that gives agents a **persistent,
user-owned memory** they can read and write mid-task. It stores episodic
observations alongside a semantic concept graph, embeds everything locally with
transformers.js, and keeps it all in IndexedDB. Nothing is sent to a server,
because there is no server.

---

## Why this use case fits WebMCP well

Most WebMCP examples take a capability a site already offers a human — book the
flight, add to cart, filter the table — and expose it as a tool so an agent can
stop scraping the DOM. That is valuable, but memory is a different and, we
think, better fit, for three reasons.

**It is tool-native.** There is no human-facing UI an agent could scrape to
recover this capability. "Remember this for later, then find it again by
meaning" is not a page an agent reads; it is an operation an agent performs.
WebMCP is not a convenience layer here, it is the only sensible interface.

**The browser is the correct owner.** Agent memory today lives server-side,
inside whichever assistant product created it: per-vendor, opaque, and
unportable. Memory in the browser is per-origin, per-profile, inspectable, and
outlives any one conversation or vendor. WebMCP is what makes that
locally-owned store reachable by an agent at all — without it, a purely
client-side memory is a place only a human can type into.

**The tools are genuinely stateful.** These are not thin CRUD wrappers.
`retrieve_relevant` runs cosine similarity over locally computed 384-dimension
embeddings; `get_working_memory` blends that similarity with an exponential
recency decay; `link_concepts` writes a node pair and an edge in one
transaction. The interesting work happens behind the tool boundary, which is
exactly what a tool boundary is for.

---

## How it improves the user experience

**You stop repeating yourself.** The agent that helps you at 4pm can pick up the
decision you recorded at 11am, without you restating it.

**Nothing to set up and nothing to trust.** No sign-up, no key, no upload. The
embedding model runs in the tab, so the text of your memories never leaves the
machine — which is what makes it reasonable to store working context in the
first place.

**Agent actions are legible.** A live Tool activity panel logs every tool call —
name, arguments, result or error, timing — as it happens. Most agent memory is
invisible: you cannot see what was saved on your behalf or why something was
recalled. Here you watch it happen, and the four panels let you read, search and
delete the store by hand.

**It degrades gracefully.** The UI calls the memory layer directly rather than
proxying through the tools, so the page is fully usable in a browser with no
WebMCP support at all. The header states plainly whether tools registered.

---

## What people and agents can now do together that was hard before

**Memory that outlives the agent.** Context recorded by one agent is available to
a different agent, in a different session, later. The memory belongs to the
browser profile, not to a vendor account, so switching assistants does not reset
what you know. This is the part that was genuinely not possible before: there
was no way for an arbitrary agent to reach a user-owned local store.

**Memory the user can audit and correct.** Because the store is local and
visible, a person can read exactly what an agent recorded, and delete it. That
inverts the usual arrangement, where memory is written about you, server-side,
and surfaced only when the system chooses to.

**A shared, inspectable working set.** Human and agent write into the same store
through different doors — the human through the form, the agent through
`store_observation` — and both read it back. It is one artifact two kinds of
participant collaborate on, rather than the agent keeping private notes.

**Honest scope:** WebMCP scopes tools to the registering tab, so this is not an
ambient memory service every tab can call. The intended pattern is that an agent
visits this page as its memory tool mid-task, uses it, and continues elsewhere.
`docs/FEATURES.md` lists the rest of the limitations plainly.

---

## The WebMCP implementation

Five tools registered through `document.modelContext.registerTool({...})`, with
`navigator.modelContext` kept as a fallback because Chrome is mid-migration
between the two namespaces.

| Tool | Does | `readOnlyHint` | `untrustedContentHint` |
|---|---|---|---|
| `store_observation` | Record something read, decided or noticed | `false` | `false` |
| `retrieve_relevant` | Semantic similarity search | `true` | `true` |
| `get_working_memory` | Relevance blended with recency | `true` | `true` |
| `link_concepts` | Write an edge in the concept graph | `false` | `false` |
| `summarize_context` | Filtered digest by time and/or topic | `true` | `true` |

Specifics worth calling out:

- **All five specs live in one `TOOL_SPECS` table**, so a tool's schema,
  annotations and handler cannot drift apart.
- **`AbortSignal` on registration.** The spec has no `unregisterTool`, so a
  signal is the only way to take tools down. Without it, React 19 StrictMode's
  double-invoked effect registers a duplicate set in development — verified in a
  headless-browser check that asserts exactly five live registrations.
- **`untrustedContentHint` is set on exactly the tools that replay stored text.**
  Stored observations are text an agent read somewhere else, so retrieval is a
  *stored* indirect-prompt-injection path: a payload persists and re-fires into
  every future retrieval. Retrieved content is wrapped in
  `<untrusted-user-content>`, truncated, and capped at 20 results; hidden
  codepoints are stripped at write time; injection-shaped text is flagged and
  badged in the UI rather than silently rewritten, because the store's job is to
  record what was actually read.
- **Tool text budgets are enforced.** `checkToolBudgets()` validates name,
  description and parameter-description lengths against Chrome's provisional
  limits, warns at registration and fails the test suite.
- **`exposedTo` is deliberately omitted** — these tools mutate the user's own
  memory, so the default audience is already the intended one and an allowlist
  could only widen it.

**Verification.** 89 unit tests (Vitest + `fake-indexeddb`) and a 42-check
headless-browser suite that drives the real registered tools, both passing
against the dev server and the production build. Lint and tests gate deployment
in CI. The threat model in `docs/SECURITY.md` states what is *not* claimed: with
no server there is no mechanism that holds when the layers above it fail, and
the last line of defense is a human reading a flag badge.

**Stack:** React 19, Vite, IndexedDB via `idb`, transformers.js
(`Xenova/all-MiniLM-L6-v2`), deployed to GitHub Pages. MIT licensed.
