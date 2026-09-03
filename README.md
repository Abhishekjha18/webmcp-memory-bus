# Agent Memory Bus

A persistent, browser-local semantic memory layer exposed to AI agents through [WebMCP](https://developer.chrome.com/docs/ai/webmcp) (`document.modelContext`, falling back to `navigator.modelContext`).

Every agent conversation starts cold, even though your browser holds enormous context — what you've read, decided, and noticed. This app is a WebMCP-enabled site an agent can visit mid-task to store and retrieve that context, backed by a dual-graph memory model (episodic observations + a semantic concept graph) inspired by the STARK architecture, running entirely client-side.

## How it works

- **Storage**: IndexedDB, entirely in your browser. Nothing is sent to a server.
- **Semantic search**: local embeddings via [transformers.js](https://github.com/huggingface/transformers.js) (`Xenova/all-MiniLM-L6-v2`), no external embedding API.
- **Exposure**: the page registers WebMCP tools any capable browser agent can call while this tab is open.

## Tools exposed

| Tool | Purpose |
|---|---|
| `store_observation(content, source_url?, timestamp?, tags?)` | Record something the agent read, decided, or noticed. |
| `retrieve_relevant(query, task_context?, limit?)` | Semantic similarity search over stored observations. |
| `get_working_memory(current_task, limit?)` | Relevant + recent observations for what's happening right now. |
| `link_concepts(entity1, entity2, relation, confidence?)` | Record a relation between two entities in the semantic graph. |
| `summarize_context(time_range?, topic_filter?)` | Filtered digest of observations + concept links for the caller to summarize. |

Full schemas, annotations and text budgets: [docs/TOOLS.md](docs/TOOLS.md).

## Security

Stored observations are text an agent read somewhere else, replayed later into a
different agent's context — a stored indirect prompt injection path. Hidden
codepoints are stripped at write time, injection-shaped content is flagged and
surfaced in the UI, retrieved content is wrapped in `<untrusted-user-content>`,
and every tool that replays stored text declares `untrustedContentHint`.

With no server there is no non-human backstop, and the threat model
([docs/SECURITY.md](docs/SECURITY.md)) says so explicitly rather than
overclaiming.

## Architecture note

WebMCP scopes registered tools to the tab that registered them — an agent must be interacting with this tab to call these tools, they aren't ambiently reachable from every other open tab. In practice: an agent working across sites explicitly visits this page as its "memory" tool mid-task, calls the tools it needs, then continues its work elsewhere.

## Local development

```bash
npm install
npm run dev
```

Requires a browser with WebMCP support enabled (e.g. Chrome 149+ with the `#enable-webmcp-testing` flag turned on).

## Build

```bash
npm run build
```

## Tests

```bash
npm test
```

89 unit tests covering sanitization, store and ranking logic, and the tool layer
(registration, annotations, budgets, shielding, activity logging) against a
mocked `modelContext` and an in-memory IndexedDB.

Lint and tests gate deployment: GitHub Actions runs `npm run lint` and `npm test`
before building, and only a green run on `main` publishes to GitHub Pages.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layer diagram, storage schema, ranking formulas, boundary decisions. |
| [docs/TOOLS.md](docs/TOOLS.md) | Per-tool schemas, annotations, errors, text budgets. |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, injection defenses, and what is deliberately not claimed. |
| [docs/FEATURES.md](docs/FEATURES.md) | What is built and working, and honest limitations. |
