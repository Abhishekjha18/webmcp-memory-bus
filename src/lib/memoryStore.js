import { getDB, OBSERVATIONS_STORE, CONCEPTS_STORE, RELATIONS_STORE } from "./db";
import { embed, cosineSimilarity } from "./embeddings";
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
