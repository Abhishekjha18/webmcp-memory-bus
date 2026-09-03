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

export async function storeObservation({ content, source_url, timestamp, tags = [] }) {
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
    timestamp: timestamp || new Date().toISOString(),
    tags: cleanTags,
    flagged,
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
    .slice(0, Math.min(limit, MAX_RETRIEVAL_LIMIT))
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
      const ageHours = Math.max(0, (now - new Date(obs.timestamp).getTime()) / 3_600_000);
      const recencyWeight = Math.pow(0.5, ageHours / recencyHalfLifeHours);
      const score = similarity * (0.7 + 0.3 * recencyWeight);
      return { ...obs, similarity, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(limit, MAX_RETRIEVAL_LIMIT))
    .map(({ embedding, ...rest }) => rest);
  return ranked;
}

export async function linkConcepts({ entity1, entity2, relation, confidence = 1 }) {
  if (!entity1 || !entity2 || !relation) {
    throw new Error("entity1, entity2, and relation are required");
  }
  const cleanEntity1 = sanitizeText(entity1);
  const cleanEntity2 = sanitizeText(entity2);
  const cleanRelation = sanitizeText(relation);
  const db = await getDB();
  const tx = db.transaction([CONCEPTS_STORE, RELATIONS_STORE], "readwrite");
  await tx.objectStore(CONCEPTS_STORE).put({ name: cleanEntity1 });
  await tx.objectStore(CONCEPTS_STORE).put({ name: cleanEntity2 });
  const id = await tx.objectStore(RELATIONS_STORE).add({
    entity1: cleanEntity1,
    entity2: cleanEntity2,
    relation: cleanRelation,
    confidence,
    timestamp: new Date().toISOString(),
  });
  await tx.done;
  notify();
  return { id, entity1: cleanEntity1, entity2: cleanEntity2, relation: cleanRelation, confidence };
}

export async function summarizeContext({ time_range, topic_filter }) {
  const observations = await allObservations();
  let filtered = observations;

  if (time_range && (time_range.start || time_range.end)) {
    const start = time_range.start ? new Date(time_range.start).getTime() : -Infinity;
    const end = time_range.end ? new Date(time_range.end).getTime() : Infinity;
    filtered = filtered.filter((obs) => {
      const t = new Date(obs.timestamp).getTime();
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
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
      tags: Array.isArray(raw.tags) ? raw.tags.map((t) => sanitizeText(String(t))) : [],
      flagged: scanForInjection(content),
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
      confidence: typeof raw.confidence === "number" ? raw.confidence : 1,
      timestamp: typeof raw.timestamp === "string" ? raw.timestamp : new Date().toISOString(),
    });
    await tx.done;
    importedRelations++;
  }

  notify();
  return { observations: importedObservations, relations: importedRelations, skipped };
}
