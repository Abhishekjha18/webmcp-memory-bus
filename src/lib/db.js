import { openDB } from "idb";

const DB_NAME = "agent-memory-bus";
const DB_VERSION = 1;

export const OBSERVATIONS_STORE = "observations";
export const CONCEPTS_STORE = "concepts";
export const RELATIONS_STORE = "relations";

let dbPromise;

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        const observations = db.createObjectStore(OBSERVATIONS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        observations.createIndex("timestamp", "timestamp");
        observations.createIndex("source_url", "source_url");

        db.createObjectStore(CONCEPTS_STORE, { keyPath: "name" });

        const relations = db.createObjectStore(RELATIONS_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        relations.createIndex("entity1", "entity1");
        relations.createIndex("entity2", "entity2");
      },
    });
  }
  return dbPromise;
}

/**
 * Approximate browser storage usage for this origin.
 *
 * `navigator.storage.estimate()` is itself approximate and, per spec, the
 * browser may pad or round the numbers to resist fingerprinting — this is
 * a rough gauge for "is this getting large," not an exact accounting. Not
 * every browser implements it (older Safari, some private-browsing modes),
 * so this degrades to `{ supported: false }` rather than throwing, the
 * same pattern used elsewhere for a browser that lacks a capability this
 * app leans on.
 */
export async function getStorageEstimate() {
  if (typeof navigator === "undefined" || !navigator.storage?.estimate) {
    return { supported: false };
  }
  try {
    const { usage, quota } = await navigator.storage.estimate();
    return { supported: true, usageBytes: usage ?? 0, quotaBytes: quota ?? 0 };
  } catch {
    return { supported: false };
  }
}
