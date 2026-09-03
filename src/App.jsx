import { useEffect, useState, useCallback, useRef } from "react";
import "./App.css";
import { registerMemoryBusTools, isWebMCPAvailable, onToolActivity } from "./lib/webmcpTools";
import { onModelProgress } from "./lib/embeddings";
import {
  storeObservation,
  retrieveRelevant,
  onMemoryChange,
  getAllObservationsForUI,
  getAllRelationsForUI,
  clearAllMemory,
  deleteObservation,
  deleteRelation,
  exportMemory,
  importMemory,
  exploreConcepts,
  AUTHORS,
} from "./lib/memoryStore";

function formatTime(iso) {
  try {
    const date = new Date(iso);
    // Show the year only when it is not the current one — otherwise a 2099
    // or 2020 record is indistinguishable from something recorded today.
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      year: sameYear ? undefined : "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

/**
 * Show where a source link actually goes.
 *
 * Observations are written by agents, so a link labelled only "source" asks
 * the reader to trust an origin they cannot see. Showing the host puts the
 * destination in front of them; anything unparseable (or a non-http scheme)
 * is surfaced as-is rather than dressed up as a normal link.
 */
function sourceLabel(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.hostname;
    return parsed.protocol.replace(":", "") + " link";
  } catch {
    return "source";
  }
}

const AUTHOR_LABELS = {
  [AUTHORS.HUMAN]: { text: "you", title: "Typed directly into this page." },
  [AUTHORS.AGENT]: {
    text: "agent",
    title: "Stored by an agent through store_observation, not typed by a person.",
  },
  [AUTHORS.IMPORTED]: {
    text: "imported",
    title: "Restored from a JSON file. Its own claimed authorship is not trusted on import.",
  },
};

const icons = {
  capture: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" strokeLinecap="round" />
    </svg>
  ),
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <path d="M3 12h4l3-7 4 14 3-7h4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  store: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </svg>
  ),
  graph: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
      <circle cx="6" cy="7" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <circle cx="12" cy="18" r="2.5" />
      <path d="M8.4 8.4l2.2 7.2M15.6 8.4l-2.2 7.2M8.5 7h7" />
    </svg>
  ),
};

function CardHeader({ icon, title, subtitle, tool, actions }) {
  return (
    <div className="card-header">
      <div className="card-heading">
        <span className="card-icon" aria-hidden="true">
          {icons[icon]}
        </span>
        <div>
          <h2>{title}</h2>
          {subtitle && <p className="card-subtitle">{subtitle}</p>}
        </div>
      </div>
      {tool && <span className="tool-chip">{tool}</span>}
      {actions}
    </div>
  );
}

export default function App() {
  const [webmcpStatus, setWebmcpStatus] = useState("checking");
  const [observations, setObservations] = useState([]);
  const [relations, setRelations] = useState([]);
  const [activity, setActivity] = useState([]);

  const [content, setContent] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [tags, setTags] = useState("");
  const [saving, setSaving] = useState(false);

  const [query, setQuery] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const [searching, setSearching] = useState(false);

  const [exploreEntity, setExploreEntity] = useState("");
  const [exploreResult, setExploreResult] = useState(null);
  const [exploring, setExploring] = useState(false);

  const [modelProgress, setModelProgress] = useState(null);
  const [transferNote, setTransferNote] = useState("");
  const fileInputRef = useRef(null);

  const refresh = useCallback(async () => {
    const [obs, rels] = await Promise.all([getAllObservationsForUI(), getAllRelationsForUI()]);
    setObservations(obs);
    setRelations(rels);
  }, []);

  useEffect(() => {
    // WebMCP has no unregisterTool; an AbortSignal is the documented way to
    // take tools back down, which StrictMode's double-mount in dev requires.
    const controller = new AbortController();
    if (isWebMCPAvailable()) {
      registerMemoryBusTools({ signal: controller.signal });
      setWebmcpStatus("available");
    } else {
      setWebmcpStatus("unavailable");
    }
    refresh();
    const unsubMemory = onMemoryChange(refresh);
    const unsubActivity = onToolActivity((entry) =>
      setActivity((prev) => [entry, ...prev].slice(0, 50))
    );
    // The ~25MB model downloads on the first embed, so without this the first
    // store or search looks like a hung button on a cold profile.
    const unsubProgress = onModelProgress((state) =>
      setModelProgress(state.status === "ready" ? null : state)
    );
    return () => {
      controller.abort();
      unsubMemory();
      unsubActivity();
      unsubProgress();
    };
  }, [refresh]);

  async function handleAddObservation(e) {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    try {
      await storeObservation({
        content: content.trim(),
        source_url: sourceUrl.trim() || undefined,
        tags: tags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
        // This form is the one genuinely first-party "a person typed this"
        // boundary — the only place author: human is honest to assert.
        author: AUTHORS.HUMAN,
      });
      setContent("");
      setSourceUrl("");
      setTags("");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearAll() {
    const confirmed = window.confirm(
      `Delete all ${observations.length} observations and ${relations.length} concept links? This cannot be undone.`,
    );
    if (!confirmed) return;
    await clearAllMemory();
    setSearchResults(null);
    setExploreResult(null);
  }

  async function handleSupersede(oldObservation) {
    const replacement = window.prompt(
      "Replacement text. The old observation stays, marked superseded, for audit.",
      oldObservation.content,
    );
    if (!replacement || !replacement.trim()) return;
    // author: human here is what makes this path allowed to supersede a
    // human-authored memory at all — see the rule in memoryStore.js.
    await storeObservation({ content: replacement.trim(), supersedes: oldObservation.id, author: AUTHORS.HUMAN });
  }

  async function handleExport() {
    const dump = await exportMemory();
    const blob = new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `agent-memory-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setTransferNote(
      `Exported ${dump.observations.length} observations and ${dump.relations.length} concept links.`,
    );
  }

  async function handleImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await importMemory(JSON.parse(await file.text()));
      setTransferNote(
        `Imported ${result.observations} observations and ${result.relations} concept links` +
          (result.skipped ? `, skipped ${result.skipped} malformed records.` : "."),
      );
    } catch (err) {
      setTransferNote(`Import failed: ${err.message}`);
    } finally {
      // Reset so re-picking the same file fires change again.
      e.target.value = "";
    }
  }

  async function handleSearch(e) {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const results = await retrieveRelevant({ query: query.trim(), limit: 5 });
      setSearchResults(results);
    } finally {
      setSearching(false);
    }
  }

  async function handleExplore(e) {
    e.preventDefault();
    if (!exploreEntity.trim()) return;
    setExploring(true);
    try {
      const result = await exploreConcepts({ entity: exploreEntity.trim(), depth: 2 });
      setExploreResult(result);
    } finally {
      setExploring(false);
    }
  }

  const statusLabel = {
    available: "Tools registered",
    unavailable: "WebMCP unavailable",
    checking: "Checking WebMCP",
  }[webmcpStatus];

  return (
    <div className="page">
      <div className="glow" aria-hidden="true" />

      <header className="header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
              <circle cx="7" cy="8" r="2.4" />
              <circle cx="17" cy="6.5" r="2.4" />
              <circle cx="16" cy="17" r="2.4" />
              <circle cx="6.5" cy="16" r="2.4" />
              <path d="M9.2 8.8l5.5-1.6M8.1 10.2l7 5.2M8.6 15.1l5-6.4M8.9 16.4h4.7" />
            </svg>
          </span>
          <div>
            <h1>Agent Memory Bus</h1>
            <p className="subtitle">
              Persistent, browser-local semantic memory that any agent can read and write over WebMCP.
            </p>
          </div>
        </div>
        <div className="status-block">
          <span className={`status-pill status-${webmcpStatus}`}>
            <span className="status-dot" aria-hidden="true" />
            {statusLabel}
          </span>
          {/* A judge who opens this URL without the flag would otherwise see
              a dead status and no way to reach the actual feature. */}
          {webmcpStatus === "unavailable" && (
            <p className="status-help">
              This browser has not enabled WebMCP. In Chrome 149+, set{" "}
              <code>chrome://flags/#enable-webmcp-testing</code> to Enabled and relaunch — the
              memory below works either way.
            </p>
          )}
        </div>
      </header>

      <div className="stats">
        <div className="stat">
          <span className="stat-value">{observations.length}</span>
          <span className="stat-label">Observations</span>
        </div>
        <div className="stat">
          <span className="stat-value">{relations.length}</span>
          <span className="stat-label">Concept links</span>
        </div>
        <div className="stat">
          <span className="stat-value">{activity.length}</span>
          <span className="stat-label">Tool calls</span>
        </div>
        <div className="stat">
          <span className="stat-value">{webmcpStatus === "available" ? 5 : 0}</span>
          <span className="stat-label">Tools exposed</span>
        </div>
      </div>

      {modelProgress && (
        <div className="model-progress" role="status">
          <div className="model-progress-label">
            {modelProgress.status === "error"
              ? `Embedding model failed to load: ${modelProgress.error}`
              : `Downloading embedding model — runs locally, once · ${modelProgress.percent}%`}
          </div>
          {modelProgress.status !== "error" && (
            <div className="model-progress-track">
              <div className="model-progress-bar" style={{ width: `${modelProgress.percent}%` }} />
            </div>
          )}
        </div>
      )}

      <main className="grid">
        <div className="column">
          <section className="card">
            <CardHeader
              icon="capture"
              title="Capture"
              subtitle="Record something worth remembering"
              tool="store_observation"
            />
            <form onSubmit={handleAddObservation} className="form">
              <textarea
                placeholder="What did you read, decide, or notice?"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={3}
                required
              />
              <input
                type="text"
                placeholder="Source URL (optional)"
                value={sourceUrl}
                onChange={(e) => setSourceUrl(e.target.value)}
              />
              <input
                type="text"
                placeholder="Tags, comma separated (optional)"
                value={tags}
                onChange={(e) => setTags(e.target.value)}
              />
              <button type="submit" disabled={saving}>
                {saving ? "Embedding…" : "Store observation"}
              </button>
            </form>
          </section>

          <section className="card">
            <CardHeader
              icon="search"
              title="Recall"
              subtitle="Search by meaning, not keywords"
              tool="retrieve_relevant"
            />
            <form onSubmit={handleSearch} className="form form-inline">
              <input
                type="text"
                placeholder="What are you looking for?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              <button type="submit" disabled={searching}>
                {searching ? "Searching…" : "Search"}
              </button>
            </form>
            {searchResults && (
              <ul className="list">
                {searchResults.length === 0 && <li className="empty">No matches found.</li>}
                {searchResults.map((r) => (
                  <li key={r.id}>
                    <div className="item-main">
                      <div className="item-content">{r.content}</div>
                      <div className="item-meta">{formatTime(r.timestamp)}</div>
                    </div>
                    <span className="score">{r.score.toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <div className="column">
          <section className="card card-tall">
            <CardHeader
              icon="activity"
              title="Tool activity"
              subtitle="Every agent call, as it happens"
            />
            <ul className="list activity-log">
              {activity.length === 0 && (
                <li className="empty">
                  No tool calls yet. Connect an agent and they will appear here live.
                </li>
              )}
              {activity.map((entry, i) => (
                <li key={i} className={entry.ok ? "ok" : "err"}>
                  <div className="item-main">
                    <code>{entry.name}</code>
                    {!entry.ok && <div className="item-error">{entry.error}</div>}
                  </div>
                  <span className="item-time">{formatTime(entry.at)}</span>
                </li>
              ))}
            </ul>
          </section>
        </div>

        <section className="card card-wide">
          <CardHeader
            icon="store"
            title={`Stored observations (${observations.length})`}
            subtitle="Episodic memory — what happened, and when"
            actions={
              <div className="card-actions">
                <button className="ghost" onClick={handleExport}>
                  Export
                </button>
                <button className="ghost" onClick={() => fileInputRef.current?.click()}>
                  Import
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="application/json,.json"
                  onChange={handleImportFile}
                  hidden
                />
                <button className="ghost danger" onClick={handleClearAll}>
                  Clear all
                </button>
              </div>
            }
          />
          {transferNote && <p className="transfer-note">{transferNote}</p>}
          <ul className="list">
            {observations.length === 0 && (
              <li className="empty">Nothing stored yet — capture your first observation above.</li>
            )}
            {observations.map((o) => (
              <li key={o.id}>
                <div className="item-main">
                  <div className={`item-content${o.supersededBy != null ? " superseded" : ""}`}>
                    {o.content}
                  </div>
                  <div className="item-meta">
                    {o.flagged && (
                      <span
                        className="chip flag"
                        title="This text matches prompt-injection patterns. It is stored and shown as-is, and is marked as untrusted content when returned to an agent."
                      >
                        flagged
                      </span>
                    )}
                    {o.supersededBy != null && (
                      <span
                        className="chip superseded-chip"
                        title="A newer observation replaces this one. Kept visible for audit, and heavily down-weighted in working-memory results."
                      >
                        superseded
                      </span>
                    )}
                    {o.supersedes != null && (
                      <span className="chip replacement-chip" title="This observation replaces an earlier one.">
                        replacement
                      </span>
                    )}
                    {AUTHOR_LABELS[o.author] && (
                      <span className={`chip author author-${o.author}`} title={AUTHOR_LABELS[o.author].title}>
                        {AUTHOR_LABELS[o.author].text}
                      </span>
                    )}
                    <span className="item-time">{formatTime(o.timestamp)}</span>
                    {o.source_url && (
                      <a href={o.source_url} target="_blank" rel="noreferrer" title={o.source_url}>
                        {sourceLabel(o.source_url)}
                      </a>
                    )}
                    {o.tags?.map((tag, i) => (
                      <span className="chip" key={`${tag}-${i}`}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="item-actions">
                  <button
                    className="delete-item supersede-item"
                    onClick={() => handleSupersede(o)}
                    title="Replace this observation with new text; the old one stays, marked superseded"
                    aria-label="Supersede this observation"
                  >
                    ↻
                  </button>
                  <button
                    className="delete-item"
                    onClick={() => deleteObservation(o.id)}
                    title="Delete this observation"
                    aria-label="Delete this observation"
                  >
                    ×
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="card card-wide">
          <CardHeader
            icon="graph"
            title={`Concept links (${relations.length})`}
            subtitle="Semantic memory — how ideas relate"
            tool="link_concepts"
          />

          <form onSubmit={handleExplore} className="form form-inline">
            <input
              type="text"
              placeholder="Explore the graph from a concept…"
              value={exploreEntity}
              onChange={(e) => setExploreEntity(e.target.value)}
            />
            <button type="submit" disabled={exploring}>
              {exploring ? "Walking graph…" : "Explore"}
            </button>
          </form>

          {exploreResult && !exploreResult.found && (
            <p className="transfer-note">
              No concept named "{exploreResult.entity}" is in the graph yet.
            </p>
          )}

          {exploreResult && exploreResult.found && (
            <div className="explore-result">
              <div className="explore-nodes">
                {exploreResult.nodes.map((n) => (
                  <span
                    key={n.name}
                    className={`chip node-chip${n.hops === 0 ? " node-chip-root" : ""}`}
                    title={n.hops === 0 ? "starting point" : `${n.hops} hop${n.hops === 1 ? "" : "s"} away`}
                  >
                    {n.name}
                    {n.hops > 0 && <span className="node-hops"> · {n.hops}</span>}
                  </span>
                ))}
              </div>
              {exploreResult.observations.length > 0 && (
                <ul className="list explore-observations">
                  {exploreResult.observations.map((o) => (
                    <li key={o.id}>
                      <div className="item-main">
                        <div className="item-content">{o.content}</div>
                        <div className="item-meta">
                          {AUTHOR_LABELS[o.author] && (
                            <span
                              className={`chip author author-${o.author}`}
                              title={AUTHOR_LABELS[o.author].title}
                            >
                              {AUTHOR_LABELS[o.author].text}
                            </span>
                          )}
                          <span className="item-time">{formatTime(o.timestamp)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <ul className="list">
            {relations.length === 0 && (
              <li className="empty">No links yet — agents build this graph as they learn.</li>
            )}
            {relations.map((r) => (
              <li key={r.id}>
                <div className="item-main">
                  <div className="item-content relation">
                    <span className="entity">{r.entity1}</span>
                    <span className="relation-arrow">{r.relation}</span>
                    <span className="entity">{r.entity2}</span>
                  </div>
                  <div className="item-meta">
                    <span className="chip">conf {r.confidence}</span>
                    <span className="item-time">{formatTime(r.timestamp)}</span>
                  </div>
                </div>
                <button
                  className="delete-item"
                  onClick={() => deleteRelation(r.id)}
                  title="Delete this concept link"
                  aria-label="Delete this concept link"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <footer className="footer">
        Runs entirely in your browser — IndexedDB storage, local embeddings, no server.
      </footer>
    </div>
  );
}
