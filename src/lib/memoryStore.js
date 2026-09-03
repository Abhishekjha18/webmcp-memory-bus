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

export async function storeObservation({ content, source_url, timestamp, tags = [], author }) {
  if (!content || typeof content !== "string") {
    throw new Error("content is required and must be a string");
  }
  const cleanContent = sanitizeText(content);
  const cleanTags = (tags || []).map((t) => sanitizeText(String(t)));
  const flagged = scanForInjection(cleanContent);
  const embedding = await embed(cleanContent);
  const db = await getDB();
  const record = {
    content: cleanContent,
    source_url: source_url || null,
    timestamp: coerceTimestamp(timestamp),
    tags: cleanTags,
    flagged,
    author: coerceAuthor(author),
    embedding,
  };
  const id = await db.add(OBSERVATIONS_STORE, record);
  notify();
  return { id, ...record };
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

export async function retrieveRelevant({ query, task_context = "", limit = 5 }) {
  if (!query || typeof query !== "string") {
    throw new Error("query is required and must be a string");
  }
  const combined = task_context ? `${query}\n${task_context}` : query;
  const queryEmbedding = await embed(combined);
  const observations = await allObservations();
  const ranked = observations
    .map((obs) => ({ ...obs, score: cosineSimilarity(queryEmbedding, obs.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, coerceLimit(limit))
    .map(({ embedding, ...rest }) => rest);
  return ranked;
}

export async function getWorkingMemory({ current_task, limit = 5, recencyHalfLifeHours = 72 }) {
  if (!current_task || typeof current_task !== "string") {
    throw new Error("current_task is required and must be a string");
  }
  const queryEmbedding = await embed(current_task);
  const observations = await allObservations();
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
      const score = similarity * (0.7 + 0.3 * recencyWeight) * (0.95 + 0.05 * provenanceWeight);
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
    await db.add(OBSERVATIONS_STORE, {
      content,
      source_url: typeof raw.source_url === "string" ? raw.source_url : null,
      timestamp: coerceTimestamp(raw.timestamp),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => sanitizeText(String(t))) : [],
      flagged: scanForInjection(content),
      // Always "imported", regardless of what raw.author claims. A file is
      // untrusted input; if this trusted whatever author value it carried,
      // a hand-crafted "export" could mark every record author: "human" and
      // buy the getWorkingMemory ranking bonus that implies.
      author: AUTHORS.IMPORTED,
      embedding,
    });
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
  return { observations: importedObservations, relations: importedRelations, skipped };
}
