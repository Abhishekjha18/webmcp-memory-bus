import { getDB, OBSERVATIONS_STORE, CONCEPTS_STORE, RELATIONS_STORE } from "./db";
import { embed, cosineSimilarity, EMBEDDING_DIMS } from "./embeddings";
import { sanitizeText, scanForInjection } from "./sanitize";

const MAX_RETRIEVAL_LIMIT = 20;

const listeners = new Set();

export function onMemoryChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn();
}

/**
 * Who actually put this observation in the store.
 *
 * "imported" is set only by importMemory itself, never through this
 * coercion — an import file is untrusted input, so whatever it claims for
 * `author` is discarded rather than trusted. See importMemory below.
 */
export const AUTHORS = { HUMAN: "human", AGENT: "agent", IMPORTED: "imported" };

/**
 * `author` is never taken from raw caller input at the WebMCP boundary —
 * only from a value the calling code itself sets after the fact. If it
 * were a plain parameter, an agent could call store_observation with
 * `author: "human"` in its arguments and inherit whatever trust that
 * implies. webmcpTools.js and bridge.html both override this field after
 * spreading the agent's args, the same pattern already used to force
 * source_url from location.href in the extension. Anything unrecognized
 * falls back to the conservative default: assume agent, not human.
 */
function coerceAuthor(author) {
  return author === AUTHORS.HUMAN ? AUTHORS.HUMAN : AUTHORS.AGENT;
}

// Bounds the dedup check to a short burst, not the whole store's history.
// The target failure mode is an agent restating the same thing many times
// in a loop; a fact legitimately re-observed months later is a different,
// legitimate case — get_working_memory's recency ranking exists precisely
// to handle two real, separately-timestamped occurrences of the same fact,
// and a global dedup scan would collapse that distinction away.
const DEDUP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Normalize text for exact-duplicate comparison: case-folded, trimmed,
 * internal whitespace collapsed, trailing punctuation stripped.
 *
 * This is deliberately NOT semantic similarity, after actually measuring
 * what that would mean: an early version compared embeddings by cosine
 * similarity, calibrated against real near-duplicates (a punctuation-only
 * variant scored ~0.98, a case-only variant ~0.96). But measuring it
 * against a realistic enumerated pattern — "filler observation 0" through
 * "23", the kind of thing a loop-tracking agent might actually write —
 * found pairs scoring as high as 0.99, HIGHER than some of the genuine
 * variants above. No single threshold separates "the same fact restated"
 * from "meaningfully different short observations that happen to share
 * most of their words": short sentence embeddings compress into a tight
 * cluster regardless of whether the differing detail is the whole point.
 * Normalized text equality is a strictly narrower, fully predictable net —
 * it catches an agent restating identical text, or a byte-identical
 * re-import, with no risk of folding two genuinely different observations
 * into one.
 */
function normalizeForDedup(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,]+$/, "");
}

/**
 * Find an existing, eligible exact-duplicate (after normalization) of a
 * not-yet-written observation, or null.
 *
 * Eligibility requires the SAME author, not just a compatible one — this
 * sidesteps the whole human/agent trust question that supersedes has to
 * navigate. An agent's restated fact can only ever merge into another
 * agent-authored row, never a human's, so dedup can't become a second,
 * quieter way to touch someone else's memory.
 */
async function findDedupTarget(store, { normalizedContent, author, timestampMs }) {
  const all = await store.getAll();
  for (const candidate of all) {
    if (candidate.author !== author) continue;
    // A superseded record is deliberately retired; dedup should not
    // quietly revive it by bumping its recency back to "current."
    if (candidate.supersededBy != null) continue;
    if (normalizeForDedup(candidate.content) !== normalizedContent) continue;
    const candidateMs = new Date(candidate.timestamp).getTime();
    if (!Number.isFinite(candidateMs) || Math.abs(candidateMs - timestampMs) > DEDUP_WINDOW_MS) {
      continue;
    }
    return candidate;
  }
  return null;
}

/**
 * Fold new metadata into a dedup target rather than creating a new row.
 * Content, author, flagged status and any supersede relationship are left
 * exactly as they were — a dedup match means the content is already
 * effectively the same, so only "still being observed" metadata (recency,
 * tags, a missing source) is refreshed.
 */
function mergeDedupTarget(target, { timestamp, tags, source_url }) {
  return {
    ...target,
    timestamp,
    tags: Array.from(new Set([...(target.tags || []), ...tags])),
    source_url: target.source_url || source_url || null,
  };
}

export async function storeObservation({
  content,
  source_url,
  timestamp,
  tags = [],
  author,
  supersedes,
}) {
  if (!content || typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  const cleanContent = sanitizeText(content);
  const cleanTags = (tags || []).map((t) => sanitizeText(String(t)));
  const flagged = scanForInjection(cleanContent);
  const cleanAuthor = coerceAuthor(author);
  const cleanTimestamp = coerceTimestamp(timestamp);
  const embedding = await embed(cleanContent);

  const db = await getDB();
  const tx = db.transaction(OBSERVATIONS_STORE, "readwrite");
  const store = tx.objectStore(OBSERVATIONS_STORE);

  // Dedup is skipped entirely when supersedes is given: that call already
  // signals "this is deliberately a new, distinct record," and silently
  // merging it away would mean the target it names never actually gets
  // marked superseded.
  const supersedesRequested = Number.isFinite(Number(supersedes));
  if (!supersedesRequested) {
    const dedupTarget = await findDedupTarget(store, {
      normalizedContent: normalizeForDedup(cleanContent),
      author: cleanAuthor,
      timestampMs: new Date(cleanTimestamp).getTime(),
    });
    if (dedupTarget) {
      const merged = mergeDedupTarget(dedupTarget, {
        timestamp: cleanTimestamp,
        tags: cleanTags,
        source_url,
      });
      await store.put(merged);
      await tx.done;
      notify();
      return { ...merged, merged: true };
    }
  }

  // Resolve the supersede target inside the same transaction as the write,
  // before the new record exists, so an invalid reference is never stored
  // as if it were real.
  //
  // Mirrors "agents write, only humans erase": an agent-authored call may
  // not demote a human-authored memory by marking it superseded — that
  // would let a hostile agent stealth-suppress a real note it dislikes
  // without ever needing a delete tool. Only a human-authored call may
  // supersede a human-authored one; anything else (agent superseding
  // agent, agent superseding imported, human superseding anything) is
  // allowed. Silently ignored rather than thrown, since supersedes is an
  // optional courtesy field, not a required contract.
  let supersedeTarget = null;
  const rawSupersedes = Number(supersedes);
  if (Number.isFinite(rawSupersedes)) {
    const candidate = await store.get(rawSupersedes);
    if (candidate && !(candidate.author === AUTHORS.HUMAN && cleanAuthor !== AUTHORS.HUMAN)) {
      supersedeTarget = candidate;
    }
  }

  const record = {
    content: cleanContent,
    source_url: source_url || null,
    timestamp: cleanTimestamp,
    tags: cleanTags,
    flagged,
    author: cleanAuthor,
    supersedes: supersedeTarget ? supersedeTarget.id : null,
    supersededBy: null,
    embedding,
  };
  const id = await store.add(record);

  if (supersedeTarget) {
    await store.put({ ...supersedeTarget, supersededBy: id });
  }

  await tx.done;
  notify();
  return { id, ...record, merged: false };
}

async function allObservations() {
  const db = await getDB();
  return db.getAll(OBSERVATIONS_STORE);
}

const DEFAULT_RETRIEVAL_LIMIT = 5;

/**
 * Coerce a caller-supplied `limit` into [1, MAX_RETRIEVAL_LIMIT].
 *
 * A raw value went straight into `Array.slice`, where anything unexpected
 * failed silently rather than loudly: a negative limit sliced from the end
 * of the ranking, and a non-numeric one produced NaN, which slices to an
 * empty array. Both hand an agent a confident, wrong answer — "your memory
 * has nothing about this" — which is worse than an error.
 */
function coerceLimit(limit) {
  const n = Number(limit);
  if (!Number.isFinite(n)) return DEFAULT_RETRIEVAL_LIMIT;
  return Math.min(Math.max(Math.floor(n), 1), MAX_RETRIEVAL_LIMIT);
}

/**
 * Milliseconds since an observation was recorded, or null when its
 * timestamp is unparseable. Import accepts any string as a timestamp, so a
 * hand-edited file can carry garbage here; letting that reach the recency
 * math turns the score into NaN and makes the whole sort order undefined.
 */
/**
 * Normalise a caller- or file-supplied timestamp to a real ISO string,
 * falling back to now. Storing an unparseable date is what let a single
 * bad record scramble recency ranking for the whole store.
 */
function coerceTimestamp(timestamp) {
  if (typeof timestamp === "string") {
    const t = new Date(timestamp).getTime();
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return new Date().toISOString();
}

function ageHoursOrNull(timestamp, now) {
  const t = new Date(timestamp).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, (now - t) / 3_600_000);
}

/**
 * Narrow a pool of observations to those carrying at least one of the
 * requested tags, case-insensitively. `tags` is a courtesy filter, not a
 * required contract — anything other than a non-empty array (missing,
 * wrong type, empty) is treated as "no filter" rather than an error, and
 * an unmatched filter returns an empty pool rather than throwing.
 *
 * Applied before ranking, not after: fewer candidates to embed-compare
 * against, and a caller scoping to a tag gets an answer only about that
 * tag's observations, not a global top-N with off-topic results crowded
 * in ahead of an on-topic one further down.
 */
function filterByTags(observations, tags) {
  if (!Array.isArray(tags) || tags.length === 0) return observations;
  const wanted = new Set(tags.map((t) => String(t).toLowerCase()));
  return observations.filter((obs) => (obs.tags || []).some((t) => wanted.has(t.toLowerCase())));
}

export async function retrieveRelevant({ query, task_context = "", limit = 5, tags }) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required and must be a string");
  }
  const combined = task_context ? `${query}\n${task_context}` : query;
  const queryEmbedding = await embed(combined);
  const observations = filterByTags(await allObservations(), tags);
  const ranked = observations
    .map((obs) => ({ ...obs, score: cosineSimilarity(queryEmbedding, obs.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, coerceLimit(limit))
    .map(({ embedding, ...rest }) => rest);
  return ranked;
}

export async function getWorkingMemory({ current_task, limit = 5, recencyHalfLifeHours = 72, tags }) {
  if (!current_task || typeof current_task !== "string") {
    throw new Error("current_task is required and must be a string");
  }
  const queryEmbedding = await embed(current_task);
  const observations = filterByTags(await allObservations(), tags);
  const now = Date.now();
  const ranked = observations
    .map((obs) => {
      const similarity = cosineSimilarity(queryEmbedding, obs.embedding);
      const ageHours = ageHoursOrNull(obs.timestamp, now);
      // An undateable record keeps its similarity but earns no recency
      // credit, rather than poisoning the sort with NaN.
      const recencyWeight = ageHours === null ? 0 : Math.pow(0.5, ageHours / recencyHalfLifeHours);
      // A much smaller floor than recency's: provenance says something about
      // how much to trust a memory, not how relevant it is, so it should
      // only nudge a near-tie, never let a barely-relevant note the user
      // typed outrank a highly relevant one an agent recorded.
      const provenanceWeight = obs.author === AUTHORS.HUMAN ? 1 : 0;
      // Unlike recency and provenance, this is not a preference dimension —
      // it is a flat, heavy demotion for a fact the user or an agent has
      // since retracted. A retracted memory should almost never win unless
      // nothing else is even remotely relevant, so this is a direct
      // multiplier rather than a bounded floor+range like the other two.
      const supersededPenalty = obs.supersededBy != null ? 0.15 : 1;
      const score =
        similarity * (0.7 + 0.3 * recencyWeight) * (0.95 + 0.05 * provenanceWeight) * supersededPenalty;
      return { ...obs, similarity, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, coerceLimit(limit))
    .map(({ embedding, ...rest }) => rest);
  return ranked;
}

/**
 * The tool schema documents confidence as 0-1, but a schema is a hint, not
 * an enforced contract — an agent can send 999 or "high". Clamp rather than
 * reject, so a bad score never silently outranks a good one in the graph.
 */
function coerceConfidence(confidence) {
  const n = Number(confidence);
  if (!Number.isFinite(n)) return 1;
  return Math.min(Math.max(n, 0), 1);
}

export async function linkConcepts({ entity1, entity2, relation, confidence = 1 }) {
  if (!entity1 || !entity2 || !relation) {
    throw new Error("entity1, entity2, and relation are required");
  }
  const cleanEntity1 = sanitizeText(entity1);
  const cleanEntity2 = sanitizeText(entity2);
  const cleanRelation = sanitizeText(relation);
  const cleanConfidence = coerceConfidence(confidence);
  const db = await getDB();
  const tx = db.transaction([CONCEPTS_STORE, RELATIONS_STORE], "readwrite");
  await tx.objectStore(CONCEPTS_STORE).put({ name: cleanEntity1 });
  await tx.objectStore(CONCEPTS_STORE).put({ name: cleanEntity2 });
  const id = await tx.objectStore(RELATIONS_STORE).add({
    entity1: cleanEntity1,
    entity2: cleanEntity2,
    relation: cleanRelation,
    confidence: cleanConfidence,
    timestamp: new Date().toISOString(),
  });
  await tx.done;
  notify();
  return {
    id,
    entity1: cleanEntity1,
    entity2: cleanEntity2,
    relation: cleanRelation,
    confidence: cleanConfidence,
  };
}

const DEFAULT_EXPLORE_DEPTH = 2;
const MAX_EXPLORE_DEPTH = 4;
// Caps the subgraph handed back to an agent — a glance at what's connected,
// not a dump of the whole graph. Kept small enough that nodes + edges +
// a handful of observations stay comfortably inside the tool output budget.
const MAX_EXPLORE_NODES = 15;
const MAX_EXPLORE_OBSERVATIONS = 5;

function coerceDepth(depth) {
  const n = Number(depth);
  if (!Number.isFinite(n)) return DEFAULT_EXPLORE_DEPTH;
  return Math.min(Math.max(Math.floor(n), 1), MAX_EXPLORE_DEPTH);
}

/**
 * Resolve a caller-supplied entity name to how it is actually stored.
 *
 * Concept names are free text typed by agents and humans — "Postgres" and
 * "postgres" are the same idea to a person but different keys in an
 * exact-match store. An exact hit is tried first (a single indexed lookup);
 * only on a miss does this fall back to scanning the concepts store for a
 * case-insensitive match, which stays cheap because that store holds one
 * row per distinct concept, not per observation.
 */
async function resolveConceptName(db, rawName) {
  const exact = await db.get(CONCEPTS_STORE, rawName);
  if (exact) return exact.name;
  const needle = rawName.toLowerCase();
  const all = await db.getAll(CONCEPTS_STORE);
  const hit = all.find((c) => c.name.toLowerCase() === needle);
  return hit ? hit.name : null;
}

/**
 * Breadth-first walk of the concept graph outward from one entity.
 *
 * `link_concepts` and `summarize_context` are the only other places the
 * graph is touched, and neither traverses it — summarize_context returns
 * edges as a flat, unordered list. Without this, the "semantic concept
 * graph" half of the dual-graph design records relationships but never
 * uses them: deleting the graph entirely would not change what any other
 * tool returns. This is what makes it load-bearing: "what do I know that's
 * connected to X, and how" is a question pure similarity search cannot
 * answer, because a connected fact may share no vocabulary with the query.
 *
 * Each hop queries the relations store's entity1/entity2 indexes directly —
 * the first real use of either, both declared in db.js since the original
 * schema but never queried until now.
 *
 * Observations bridge to the graph through their tags, the one existing
 * free-text link between the episodic and semantic stores: an observation
 * tagged "postgres" is treated as being about the concept node "postgres".
 */
export async function exploreConcepts({ entity, depth = DEFAULT_EXPLORE_DEPTH }) {
  if (!entity || typeof entity !== "string") {
    throw new Error("entity is required and must be a string");
  }
  const maxDepth = coerceDepth(depth);
  const db = await getDB();
  const cleanEntity = sanitizeText(entity);
  const rootName = await resolveConceptName(db, cleanEntity);
  if (!rootName) {
    return { entity: cleanEntity, found: false, nodes: [], edges: [], observations: [] };
  }

  const distances = new Map([[rootName, 0]]);
  const edgesSeen = new Map();
  let frontier = [rootName];

  for (
    let hop = 1;
    hop <= maxDepth && frontier.length > 0 && distances.size < MAX_EXPLORE_NODES;
    hop++
  ) {
    const nextFrontier = [];
    for (const name of frontier) {
      const [asFirst, asSecond] = await Promise.all([
        db.getAllFromIndex(RELATIONS_STORE, "entity1", name),
        db.getAllFromIndex(RELATIONS_STORE, "entity2", name),
      ]);
      for (const rel of [...asFirst, ...asSecond]) {
        edgesSeen.set(rel.id, rel);
        const other = rel.entity1 === name ? rel.entity2 : rel.entity1;
        if (!distances.has(other) && distances.size < MAX_EXPLORE_NODES) {
          distances.set(other, hop);
          nextFrontier.push(other);
        }
      }
    }
    frontier = nextFrontier;
  }

  const nodeNames = [...distances.keys()];
  const nodeSet = new Set(nodeNames.map((n) => n.toLowerCase()));
  const edges = [...edgesSeen.values()].map(({ id, ...rest }) => rest);
  const observations = (await allObservations())
    .filter((obs) => (obs.tags || []).some((t) => nodeSet.has(t.toLowerCase())))
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, MAX_EXPLORE_OBSERVATIONS)
    .map(({ embedding, ...rest }) => rest);

  return {
    entity: rootName,
    found: true,
    nodes: nodeNames.map((name) => ({ name, hops: distances.get(name) })),
    edges,
    observations,
  };
}

export async function summarizeContext({ time_range, topic_filter }) {
  const observations = await allObservations();
  let filtered = observations;

  if (time_range && (time_range.start || time_range.end)) {
    // An unparseable bound used to become NaN, and every comparison against
    // NaN is false — so a typo'd date silently reported an empty memory
    // instead of an error. An unusable bound is now simply not applied.
    const parse = (value) => {
      if (!value) return null;
      const t = new Date(value).getTime();
      return Number.isFinite(t) ? t : null;
    };
    const start = parse(time_range.start) ?? -Infinity;
    const end = parse(time_range.end) ?? Infinity;
    filtered = filtered.filter((obs) => {
      const t = new Date(obs.timestamp).getTime();
      // Keep undateable records rather than dropping them invisibly.
      if (!Number.isFinite(t)) return true;
      return t >= start && t <= end;
    });
  }

  if (topic_filter) {
    const needle = topic_filter.toLowerCase();
    filtered = filtered.filter(
      (obs) =>
        obs.content.toLowerCase().includes(needle) ||
        (obs.tags || []).some((t) => t.toLowerCase().includes(needle))
    );
  }

  filtered.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

  const db = await getDB();
  const relations = await db.getAll(RELATIONS_STORE);

  return {
    observation_count: filtered.length,
    observations: filtered.slice(0, 20).map(({ embedding, ...rest }) => rest),
    related_concept_links: relations.slice(0, 20),
  };
}

export async function getAllObservationsForUI() {
  const observations = await allObservations();
  return observations
    .map(({ embedding, ...rest }) => rest)
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

export async function getAllRelationsForUI() {
  const db = await getDB();
  return db.getAll(RELATIONS_STORE);
}

export async function clearAllMemory() {
  const db = await getDB();
  await db.clear(OBSERVATIONS_STORE);
  await db.clear(CONCEPTS_STORE);
  await db.clear(RELATIONS_STORE);
  notify();
}

export async function deleteObservation(id) {
  const db = await getDB();
  await db.delete(OBSERVATIONS_STORE, id);
  notify();
}

export async function deleteRelation(id) {
  const db = await getDB();
  await db.delete(RELATIONS_STORE, id);
  notify();
}

const EXPORT_VERSION = 1;

/**
 * Serialize the whole store, embeddings included.
 *
 * Keeping the vectors makes re-import fast and offline, and they are derived
 * from content that is already in the file — so they leak nothing the export
 * does not already contain.
 */
export async function exportMemory() {
  const db = await getDB();
  const [observations, relations] = await Promise.all([
    db.getAll(OBSERVATIONS_STORE),
    db.getAll(RELATIONS_STORE),
  ]);
  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    observations,
    relations,
  };
}

/**
 * Merge an exported file back in.
 *
 * An import file is untrusted input — it may have been edited by hand or come
 * from someone else — so every record goes through exactly the same
 * sanitization and injection scan as agent-written content, and malformed
 * records are skipped rather than aborting the whole import.
 *
 * Ids are not preserved: records are appended, so importing never overwrites
 * or silently merges with an existing memory.
 */
export async function importMemory(data) {
  if (!data || typeof data !== "object") {
    throw new Error("import file is not valid JSON object data");
  }
  if (data.version !== EXPORT_VERSION) {
    throw new Error(`unsupported export version: ${data.version ?? "missing"}`);
  }
  if (!Array.isArray(data.observations) || !Array.isArray(data.relations)) {
    throw new Error("import file is missing observations or relations");
  }

  const db = await getDB();
  let importedObservations = 0;
  let mergedObservations = 0;
  let importedRelations = 0;
  let skipped = 0;

  for (const raw of data.observations) {
    if (!raw || typeof raw.content !== "string" || !raw.content) {
      skipped++;
      continue;
    }
    const content = sanitizeText(raw.content);
    const valid =
      Array.isArray(raw.embedding) &&
      raw.embedding.length === EMBEDDING_DIMS &&
      raw.embedding.every((n) => typeof n === "number" && Number.isFinite(n));
    // Re-embed when the vector is unusable, or when sanitizing changed the
    // text out from under it.
    const embedding = valid && content === raw.content ? raw.embedding : await embed(content);
    const timestamp = coerceTimestamp(raw.timestamp);
    const tags = Array.isArray(raw.tags) ? raw.tags.map((t) => sanitizeText(String(t))) : [];
    const source_url = typeof raw.source_url === "string" ? raw.source_url : null;

    // Own transaction per record: a per-record dedup lookup needs a read
    // before its write, same reasoning as storeObservation's supersede
    // resolution. Re-importing the same file — the exact bug this closes —
    // now merges into the earlier import's rows (same author: "imported",
    // same timestamps, since both came from the same source file) instead
    // of duplicating them.
    const tx = db.transaction(OBSERVATIONS_STORE, "readwrite");
    const store = tx.objectStore(OBSERVATIONS_STORE);
    const dedupTarget = await findDedupTarget(store, {
      normalizedContent: normalizeForDedup(content),
      author: AUTHORS.IMPORTED,
      timestampMs: new Date(timestamp).getTime(),
    });
    if (dedupTarget) {
      await store.put(mergeDedupTarget(dedupTarget, { timestamp, tags, source_url }));
      await tx.done;
      mergedObservations++;
      continue;
    }

    await store.add({
      content,
      source_url,
      timestamp,
      tags,
      flagged: scanForInjection(content),
      // Always "imported", regardless of what raw.author claims. A file is
      // untrusted input; if this trusted whatever author value it carried,
      // a hand-crafted "export" could mark every record author: "human" and
      // buy the getWorkingMemory ranking bonus that implies.
      author: AUTHORS.IMPORTED,
      // supersedes/supersededBy are always dropped on import, never read
      // from raw. Ids are reassigned by autoIncrement on add — "ids are not
      // preserved" is already the documented contract — so any cross-
      // reference an export file carries points at an id that means
      // nothing, or worse, coincidentally points at an unrelated record in
      // the destination store. Rebuilding the relationship across an
      // import would need a full old-id -> new-id remap in a first pass,
      // which is a real feature in its own right; dropping it here keeps
      // import from ever wiring a stale or wrong version relationship.
      supersedes: null,
      supersededBy: null,
      embedding,
    });
    await tx.done;
    importedObservations++;
  }

  for (const raw of data.relations) {
    if (!raw || !raw.entity1 || !raw.entity2 || !raw.relation) {
      skipped++;
      continue;
    }
    const entity1 = sanitizeText(String(raw.entity1));
    const entity2 = sanitizeText(String(raw.entity2));
    const tx = db.transaction([CONCEPTS_STORE, RELATIONS_STORE], "readwrite");
    await tx.objectStore(CONCEPTS_STORE).put({ name: entity1 });
    await tx.objectStore(CONCEPTS_STORE).put({ name: entity2 });
    await tx.objectStore(RELATIONS_STORE).add({
      entity1,
      entity2,
      relation: sanitizeText(String(raw.relation)),
      confidence: coerceConfidence(raw.confidence),
      timestamp: coerceTimestamp(raw.timestamp),
    });
    await tx.done;
    importedRelations++;
  }

  notify();
  return {
    observations: importedObservations,
    merged: mergedObservations,
    relations: importedRelations,
    skipped,
  };
}
