/**
 * Regression tests for malformed tool arguments and malformed imported
 * records.
 *
 * A tool inputSchema is a hint to an agent, not an enforced contract: the
 * values that actually arrive can be the wrong type, out of range, or
 * unparseable. Each case here previously produced a confident wrong answer
 * (an empty result set, or an undefined sort order) rather than an error,
 * which is the worse failure for a memory an agent is trusting.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./embeddings", async () => {
  const EMBEDDING_DIMS = 384;
  return {
    EMBEDDING_DIMS,
    // Deterministic stand-in so ranking is inspectable without the model.
    embed: async (text) => {
      const v = new Array(EMBEDDING_DIMS).fill(0);
      v[0] = text.includes("alpha") ? 1 : 0.5;
      return v;
    },
    cosineSimilarity: (a, b) => a.reduce((s, x, i) => s + x * b[i], 0),
    onModelProgress: () => () => {},
  };
});

const {
  storeObservation,
  retrieveRelevant,
  getWorkingMemory,
  linkConcepts,
  summarizeContext,
  importMemory,
  clearAllMemory,
  getAllObservationsForUI,
  getAllRelationsForUI,
} = await import("./memoryStore");

async function seed(n) {
  for (let i = 0; i < n; i++) {
    await storeObservation({ content: `alpha record ${i}` });
  }
}

describe("retrieval limit coercion", () => {
  beforeEach(async () => {
    await clearAllMemory();
    await seed(6);
  });

  it("honours a normal limit", async () => {
    expect(await retrieveRelevant({ query: "alpha", limit: 3 })).toHaveLength(3);
  });

  it("clamps a negative limit to one row instead of slicing from the end", async () => {
    // Previously Array.slice(0, -5) returned "all but the last five", which
    // is an arbitrary subset rather than a top-N ranking.
    expect(await retrieveRelevant({ query: "alpha", limit: -5 })).toHaveLength(1);
  });

  it("treats a non-numeric limit as the default instead of returning nothing", async () => {
    // Previously NaN sliced to an empty array: memory looked empty.
    expect(await retrieveRelevant({ query: "alpha", limit: "abc" })).toHaveLength(5);
  });

  it("floors a zero limit to one row", async () => {
    expect(await retrieveRelevant({ query: "alpha", limit: 0 })).toHaveLength(1);
  });

  it("still caps an oversized limit", async () => {
    const res = await retrieveRelevant({ query: "alpha", limit: 9999 });
    expect(res.length).toBeLessThanOrEqual(6);
  });

  it("applies the same coercion to get_working_memory", async () => {
    expect(await getWorkingMemory({ current_task: "alpha", limit: "abc" })).toHaveLength(5);
  });
});

describe("timestamp handling", () => {
  beforeEach(async () => {
    await clearAllMemory();
  });

  it("normalises an unparseable timestamp at write time", async () => {
    const rec = await storeObservation({ content: "alpha", timestamp: "not-a-real-date" });
    expect(Number.isFinite(new Date(rec.timestamp).getTime())).toBe(true);
  });

  it("preserves a valid timestamp", async () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const rec = await storeObservation({ content: "alpha", timestamp: iso });
    expect(rec.timestamp).toBe(iso);
  });

  it("never scores a record NaN, so the sort order stays defined", async () => {
    await storeObservation({ content: "alpha good" });
    await storeObservation({ content: "alpha odd", timestamp: "nonsense" });
    const res = await getWorkingMemory({ current_task: "alpha" });
    for (const r of res) {
      expect(Number.isFinite(r.score)).toBe(true);
    }
  });
});

describe("confidence coercion", () => {
  beforeEach(async () => {
    await clearAllMemory();
  });

  it("clamps an over-range confidence into 0-1", async () => {
    const r = await linkConcepts({ entity1: "a", entity2: "b", relation: "r", confidence: 999 });
    expect(r.confidence).toBe(1);
  });

  it("clamps a negative confidence to zero", async () => {
    const r = await linkConcepts({ entity1: "a", entity2: "b", relation: "r", confidence: -3 });
    expect(r.confidence).toBe(0);
  });

  it("falls back to 1 for a non-numeric confidence", async () => {
    const r = await linkConcepts({ entity1: "a", entity2: "b", relation: "r", confidence: "high" });
    expect(r.confidence).toBe(1);
  });
});

describe("summarize_context time_range", () => {
  beforeEach(async () => {
    await clearAllMemory();
    await storeObservation({ content: "alpha one" });
  });

  it("ignores an unparseable bound rather than reporting an empty memory", async () => {
    const res = await summarizeContext({ time_range: { start: "nonsense" } });
    expect(res.observation_count).toBe(1);
  });

  it("still applies a valid bound", async () => {
    const res = await summarizeContext({ time_range: { start: "2099-01-01T00:00:00.000Z" } });
    expect(res.observation_count).toBe(0);
  });
});

describe("import hardening", () => {
  beforeEach(async () => {
    await clearAllMemory();
  });

  it("normalises garbage timestamps and confidences from a hand-edited file", async () => {
    await importMemory({
      version: 1,
      observations: [{ content: "alpha imported", timestamp: "garbage", tags: [] }],
      relations: [
        { entity1: "a", entity2: "b", relation: "r", confidence: 42, timestamp: "garbage" },
      ],
    });
    const [obs] = await getAllObservationsForUI();
    const [rel] = await getAllRelationsForUI();
    expect(Number.isFinite(new Date(obs.timestamp).getTime())).toBe(true);
    expect(rel.confidence).toBeLessThanOrEqual(1);
    expect(Number.isFinite(new Date(rel.timestamp).getTime())).toBe(true);
  });
});
