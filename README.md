# Agent Memory Bus

**Live app: <https://abhishekjha18.github.io/webmcp-memory-bus/>**

Created by Abhishek Jha with Codex.

A persistent, browser-local semantic memory layer exposed to AI agents through [WebMCP](https://developer.chrome.com/docs/ai/webmcp) (`document.modelContext`, falling back to `navigator.modelContext`).

Every agent conversation starts cold, even though your browser holds enormous context — what you've read, decided, and noticed. This app is a WebMCP-enabled site an agent can visit mid-task to store and retrieve that context, backed by a dual-graph memory model (episodic observations + a semantic concept graph) inspired by the STARK architecture, running entirely client-side.

## Trying it out

The page works in **any** browser — the five cards call the memory layer
directly, so you can store, search and browse without an agent present. That
path needs no flags and no setup.

To exercise the **WebMCP tools** themselves you need an agent-capable browser:

- **Chrome 149+**: enable `chrome://flags/#enable-webmcp-testing`, restart, then
  open the live URL. The badge in the header reads *"WebMCP tools registered"*
  once the six tools are live, and every agent call appears in the **Tool
  activity** panel in real time.
- **ChatGPT's in-app browser**: open the live URL and ask the agent to store and
  retrieve observations.

No account, no API key, no payment, no authentication of any kind — everything
runs client-side in the tab. First load pulls ~25MB of model weights for local
embeddings, so give the very first store or search a few seconds; it is cached
afterwards.

Suggested things to ask an agent:

1. *"Store an observation that we chose IndexedDB over localStorage because the embeddings are too big."*
2. *"What do I know about storage decisions?"* — hits `retrieve_relevant`.
3. *"Link 'IndexedDB' and 'embeddings' with the relation 'stores'."*
4. *"What was I just working on?"* — hits `get_working_memory`, which blends recency in.

## How it works

- **Storage**: IndexedDB, entirely in your browser. Nothing is sent to a server.
- **Semantic search**: local embeddings via [transformers.js](https://github.com/huggingface/transformers.js) (`Xenova/all-MiniLM-L6-v2`), no external embedding API.
- **Exposure**: the page registers WebMCP tools any capable browser agent can call while this tab is open.

## Tools exposed

| Tool | Purpose |
|---|---|
| `store_observation(content, source_url?, timestamp?, tags?, supersedes?)` | Record something the agent read, decided, or noticed; optionally retire an older observation by id. |
| `retrieve_relevant(query, task_context?, limit?, tags?)` | Semantic similarity search over stored observations. |
| `get_working_memory(current_task, limit?, tags?)` | Relevant + recent observations for what's happening right now. |
| `link_concepts(entity1, entity2, relation, confidence?)` | Record a relation between two entities in the semantic graph. |
| `summarize_context(time_range?, topic_filter?)` | Filtered digest of observations + concept links for the caller to summarize. |
| `explore_concepts(entity, depth?)` | Walk the concept graph outward from one entity, returning connected concepts, edges, and tagged observations. |

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

## Ambient mode (optional companion extension)

That tab-scoping is the one limit between this and "your browser has memory."
[`extension/`](extension/) removes it without changing what the standard allows: it registers the
same six tools on every page you visit, so an agent helping you on `github.com` can reach what you
recorded yesterday without being sent to the Memory Bus tab first.

The extension stores nothing itself. Every call is forwarded to `bridge.html` on this origin, so it
reads and writes the **same** IndexedDB this site displays — one memory, inspectable and deletable in
one place. All sanitisation, injection flagging, envelopes and limit clamping stay in the modules
here; the extension is transport only.

See [`extension/README.md`](extension/README.md) to install it unpacked.

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

194 unit tests covering sanitization, store and ranking logic, graph traversal,
and the tool layer (registration, annotations, budgets, shielding, activity
logging) against a mocked `modelContext` and an in-memory IndexedDB, plus a
real-stack integration suite that runs the same tools against the actual
transformers.js model and IndexedDB (`RUN_INTEGRATION=1 npm test`).

Lint and tests gate deployment: GitHub Actions runs `npm run lint` and `npm test`
before building, and only a green run on `main` publishes to GitHub Pages.

## Documentation

| Doc | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Layer diagram, storage schema, ranking formulas, boundary decisions. |
| [docs/TOOLS.md](docs/TOOLS.md) | Per-tool schemas, annotations, errors, text budgets. |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, injection defenses, and what is deliberately not claimed. |
| [docs/FEATURES.md](docs/FEATURES.md) | What is built and working, and honest limitations. |
| [docs/DEVPOST.md](docs/DEVPOST.md) | Submission write-up: why this fits WebMCP, and what it changes. |
| [docs/DEMO_SCRIPT.md](docs/DEMO_SCRIPT.md) | Walkthrough script for the demo video. |

## License

[MIT](LICENSE)
