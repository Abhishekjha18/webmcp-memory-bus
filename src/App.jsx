import { useEffect, useState, useCallback } from "react";
import "./App.css";
import { registerMemoryBusTools, isWebMCPAvailable, onToolActivity } from "./lib/webmcpTools";
import {
  storeObservation,
  retrieveRelevant,
  onMemoryChange,
  getAllObservationsForUI,
  getAllRelationsForUI,
  clearAllMemory,
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
    return () => {
      controller.abort();
      unsubMemory();
      unsubActivity();
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
        <div>
          <h1>Agent Memory Bus</h1>
          <p className="subtitle">Persistent, browser-local semantic memory exposed over WebMCP.</p>
        </div>
        <span className={`status-badge status-${webmcpStatus}`}>
          {webmcpStatus === "available" && "WebMCP tools registered"}
          {webmcpStatus === "unavailable" && "WebMCP not available in this browser"}
          {webmcpStatus === "checking" && "Checking WebMCP..."}
        </span>
      </header>

      <main className="grid">
        <section className="panel">
          <h2>Add an observation</h2>
          <p className="hint">
            Manual entry point for testing. In real use, an agent calls the{" "}
            <code>store_observation</code> tool for you.
          </p>
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

          <h2>Test retrieval</h2>
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
                  <div className="score">{r.score.toFixed(3)}</div>
                  <div>
                    <div className="obs-content">{r.content}</div>
                    <div className="obs-meta">{formatTime(r.timestamp)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Tool activity</h2>
          <p className="hint">Live log of every WebMCP tool call an agent has made against this memory.</p>
          <ul className="activity-log">
            {activity.length === 0 && <li className="empty">No tool calls yet.</li>}
            {activity.map((entry, i) => (
              <li key={i} className={entry.ok ? "ok" : "err"}>
                <code>{entry.name}</code>
                <span className="activity-time">{formatTime(entry.at)}</span>
                {!entry.ok && <div className="activity-error">{entry.error}</div>}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2>Stored observations ({observations.length})</h2>
            <button className="ghost" onClick={clearAllMemory}>
              Clear all
            </button>
          </div>
          <ul className="obs-list">
            {observations.length === 0 && <li className="empty">Nothing stored yet.</li>}
            {observations.map((o) => (
              <li key={o.id}>
                <div className="obs-content">{o.content}</div>
                <div className="obs-meta">
                  {formatTime(o.timestamp)}
                  {o.source_url && (
                    <>
                      {" · "}
                      <a href={o.source_url} target="_blank" rel="noreferrer">
                        source
                      </a>
                    </>
                  )}
                  {o.tags?.length > 0 && <> · {o.tags.join(", ")}</>}
                </div>
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
                <div className="obs-content">
                  <strong>{r.entity1}</strong> —{r.relation}→ <strong>{r.entity2}</strong>
                </div>
                <div className="obs-meta">
                  confidence {r.confidence} · {formatTime(r.timestamp)}
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
