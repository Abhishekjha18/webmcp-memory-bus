// IndexedDB does not exist in Node. fake-indexeddb/auto installs a spec-compliant
// in-memory implementation on globalThis, so db.js and memoryStore.js run unmodified.
import "fake-indexeddb/auto";
