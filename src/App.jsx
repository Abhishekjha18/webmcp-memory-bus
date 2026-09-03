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
} from "./lib/memoryStore";

function formatTime(iso) {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
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

  return (
    <div className="page">
      <header className="header">
        <div className="brand">
          <div>
            <h1>Agent Memory Bus</h1>
            <p className="subtitle">Persistent, browser-local semantic memory exposed over WebMCP.</p>
          </div>
        </div>
        <span className={`status-badge status-${webmcpStatus}`}>
          <span className="status-dot" aria-hidden="true" />
          {webmcpStatus === "available" && "WebMCP tools registered"}
          {webmcpStatus === "unavailable" && "WebMCP not available in this browser"}
          {webmcpStatus === "checking" && "Checking WebMCP..."}
        </span>
      </header>

      {modelProgress && (
        <div className="model-progress" role="status">
          <div className="model-progress-label">
            {modelProgress.status === "error"
              ? `Embedding model failed to load: ${modelProgress.error}`
              : `Downloading embedding model (runs locally, once) — ${modelProgress.percent}%`}
          </div>
          {modelProgress.status !== "error" && (
            <div className="model-progress-track">
              <div className="model-progress-bar" style={{ width: `${modelProgress.percent}%` }} />
            </div>
          )}
        </div>
      )}

      <main className="grid">
        <section className="panel">
          <div className="panel-header">
            <h2>Add an observation</h2>
            <p className="hint" style={{ margin: 0 }}>
              An agent normally calls <code>store_observation</code> for you
            </p>
          </div>
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
              {saving ? "Embedding + saving..." : "Store observation"}
            </button>
          </form>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Search memory</h2>
            <p className="hint" style={{ margin: 0 }}>
              Semantic similarity, not keyword match
            </p>
          </div>
          <form onSubmit={handleSearch} className="form">
            <input
              type="text"
              placeholder="Search stored memory by meaning..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <button type="submit" disabled={searching}>
              {searching ? "Searching..." : "retrieve_relevant"}
            </button>
          </form>
          {searchResults && (
            <ul className="results">
              {searchResults.length === 0 && <li className="empty">No matches.</li>}
              {searchResults.map((r) => (
                <li key={r.id}>
                  <div>
                    <div className="obs-content">{r.content}</div>
                    <div className="obs-meta">{formatTime(r.timestamp)}</div>
                  </div>
                  <div className="score">{r.score.toFixed(3)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Tool activity</h2>
            <p className="hint" style={{ margin: 0 }}>Every call an agent makes, live</p>
          </div>
          <ul className="activity-log">
            {activity.length === 0 && <li className="empty">No tool calls yet.</li>}
            {activity.map((entry, i) => (
              <li key={i} className={entry.ok ? "ok" : "err"}>
                <div className="activity-log-main">
                  <code>{entry.name}</code>
                  {!entry.ok && <div className="activity-error">{entry.error}</div>}
                </div>
                <span className="activity-time">{formatTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Stored observations ({observations.length})</h2>
            <div className="panel-actions">
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
              <button className="ghost" onClick={handleClearAll}>
                Clear all
              </button>
            </div>
          </div>
          {transferNote && <p className="transfer-note">{transferNote}</p>}
          <ul className="obs-list">
            {observations.length === 0 && <li className="empty">Nothing stored yet.</li>}
            {observations.map((o) => (
              <li key={o.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="obs-content">{o.content}</div>
                  <div className="obs-meta">
                    {o.flagged && (
                      <span
                        className="badge flag"
                        title="This text matches prompt-injection patterns. It is stored and shown as-is, and is marked as untrusted content when returned to an agent."
                      >
                        flagged
                      </span>
                    )}
                    <span>{formatTime(o.timestamp)}</span>
                    {o.source_url && (
                      <a href={o.source_url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    )}
                    {o.tags?.map((tag) => (
                      <span className="badge" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                </div>
                <button
                  className="delete-item"
                  onClick={() => deleteObservation(o.id)}
                  title="Delete this observation"
                  aria-label="Delete this observation"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <h2>Concept links ({relations.length})</h2>
          <ul className="obs-list">
            {relations.length === 0 && <li className="empty">No links recorded yet.</li>}
            {relations.map((r) => (
              <li key={r.id}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="obs-content">
                    <strong>{r.entity1}</strong> —{r.relation}→ <strong>{r.entity2}</strong>
                  </div>
                  <div className="obs-meta">
                    <span className="badge">conf {r.confidence}</span>
                    <span>{formatTime(r.timestamp)}</span>
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
    </div>
  );
}
