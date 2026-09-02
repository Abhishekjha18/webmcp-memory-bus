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
