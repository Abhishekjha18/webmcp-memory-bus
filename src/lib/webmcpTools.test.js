import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("./memoryStore", () => ({
  storeObservation: vi.fn(async (args) => ({ id: 1, ...args })),
  retrieveRelevant: vi.fn(async () => [
    { id: 1, content: "a stored observation", score: 0.9, timestamp: "2024-01-01T00:00:00.000Z" },
  ]),
  getWorkingMemory: vi.fn(async () => [
    { id: 2, content: "a recent observation", score: 0.8, similarity: 0.9 },
  ]),
  linkConcepts: vi.fn(async (args) => ({ id: 3, ...args })),
  summarizeContext: vi.fn(async () => ({
    observation_count: 1,
    observations: [{ id: 4, content: "summarized observation" }],
    related_concept_links: [],
  })),
}));

const { registerMemoryBusTools, isWebMCPAvailable } = await import("./webmcpTools");

function makeModelContext() {
  const registered = new Map();
  return {
    registered,
    registerTool(spec, options) {
      registered.set(spec.name, { spec, options });
    },
  };
}

afterEach(() => {
  delete globalThis.document;
  delete globalThis.navigator;
  vi.clearAllMocks();
});

describe("getModelContext namespace resolution", () => {
  it("reports unavailable when neither namespace exists", () => {
    expect(isWebMCPAvailable()).toBe(false);
    expect(registerMemoryBusTools()).toBe(false);
  });

  it("finds document.modelContext", () => {
    globalThis.document = { modelContext: makeModelContext() };
    expect(isWebMCPAvailable()).toBe(true);
  });

  it("falls back to navigator.modelContext", () => {
    globalThis.navigator = { modelContext: makeModelContext() };
    expect(isWebMCPAvailable()).toBe(true);
  });

  it("prefers document.modelContext over navigator.modelContext", () => {
    // Chrome is mid-migration; document is the current spec surface, so a build
    // exposing both must not get its tools registered on the legacy namespace.
    const doc = makeModelContext();
    const nav = makeModelContext();
    globalThis.document = { modelContext: doc };
    globalThis.navigator = { modelContext: nav };
    registerMemoryBusTools();
    expect(doc.registered.size).toBe(5);
    expect(nav.registered.size).toBe(0);
  });
});

describe("registerMemoryBusTools", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeModelContext();
    globalThis.document = { modelContext: ctx };
  });

  it("registers all five tools and returns true", () => {
    expect(registerMemoryBusTools()).toBe(true);
    expect([...ctx.registered.keys()].sort()).toEqual([
      "get_working_memory",
      "link_concepts",
      "retrieve_relevant",
      "store_observation",
      "summarize_context",
    ]);
  });

  it("passes the abort signal through so tools can be torn down", () => {
    const controller = new AbortController();
    registerMemoryBusTools({ signal: controller.signal });
    for (const { options } of ctx.registered.values()) {
      expect(options.signal).toBe(controller.signal);
    }
  });

  it("omits the options argument entirely when no signal is given", () => {
    registerMemoryBusTools();
    for (const { options } of ctx.registered.values()) {
      expect(options).toBeUndefined();
    }
  });

  it("omits exposedTo, keeping tools scoped to agents on this page", () => {
    registerMemoryBusTools({ signal: new AbortController().signal });
    for (const { options } of ctx.registered.values()) {
      expect(options.exposedTo).toBeUndefined();
    }
  });

  it("gives every tool a name, description, inputSchema and execute", () => {
    registerMemoryBusTools();
    for (const { spec } of ctx.registered.values()) {
      expect(typeof spec.name).toBe("string");
      expect(typeof spec.description).toBe("string");
      expect(spec.inputSchema.type).toBe("object");
      expect(typeof spec.execute).toBe("function");
    }
  });
});
