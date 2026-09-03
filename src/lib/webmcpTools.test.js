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
  exploreConcepts: vi.fn(async () => ({
    entity: "postgres",
    found: true,
    nodes: [{ name: "postgres", hops: 0 }, { name: "rollback", hops: 1 }],
    edges: [{ entity1: "postgres", entity2: "rollback", relation: "requires", confidence: 1 }],
    observations: [{ id: 5, content: "connected observation" }],
  })),
}));

const {
  registerMemoryBusTools,
  isWebMCPAvailable,
  onToolActivity,
  checkToolBudgets,
  TOOL_BUDGETS,
  TOOL_SPECS,
} = await import("./webmcpTools");

const { storeObservation, retrieveRelevant } = await import("./memoryStore");

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
    expect(doc.registered.size).toBe(6);
    expect(nav.registered.size).toBe(0);
  });
});

describe("registerMemoryBusTools", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeModelContext();
    globalThis.document = { modelContext: ctx };
  });

  it("registers all six tools and returns true", () => {
    expect(registerMemoryBusTools()).toBe(true);
    expect([...ctx.registered.keys()].sort()).toEqual([
      "explore_concepts",
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

describe("tool annotations", () => {
  beforeEach(() => {
    globalThis.document = { modelContext: makeModelContext() };
  });

  it("marks the four read tools readOnlyHint and the two writers not", () => {
    const byName = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s.annotations]));
    expect(byName.retrieve_relevant.readOnlyHint).toBe(true);
    expect(byName.get_working_memory.readOnlyHint).toBe(true);
    expect(byName.summarize_context.readOnlyHint).toBe(true);
    expect(byName.explore_concepts.readOnlyHint).toBe(true);
    expect(byName.store_observation.readOnlyHint).toBe(false);
    expect(byName.link_concepts.readOnlyHint).toBe(false);
  });

  it("marks every tool that replays stored text as untrustedContentHint", () => {
    // This is the injection-relevant annotation: any tool whose output can
    // carry text an agent did not write must declare it.
    const byName = Object.fromEntries(TOOL_SPECS.map((s) => [s.name, s.annotations]));
    expect(byName.retrieve_relevant.untrustedContentHint).toBe(true);
    expect(byName.get_working_memory.untrustedContentHint).toBe(true);
    expect(byName.summarize_context.untrustedContentHint).toBe(true);
    expect(byName.explore_concepts.untrustedContentHint).toBe(true);
    expect(byName.store_observation.untrustedContentHint).toBe(false);
    expect(byName.link_concepts.untrustedContentHint).toBe(false);
  });

  it("declares annotations on every registered tool", () => {
    registerMemoryBusTools();
    for (const spec of TOOL_SPECS) {
      expect(spec.annotations).toBeDefined();
      expect(typeof spec.annotations.readOnlyHint).toBe("boolean");
      expect(typeof spec.annotations.untrustedContentHint).toBe("boolean");
    }
  });
});

describe("checkToolBudgets", () => {
  it("finds no violations in the shipped tool set", () => {
    expect(checkToolBudgets()).toEqual([]);
  });

  it("catches an over-long tool name", () => {
    const violations = checkToolBudgets([
      { name: "x".repeat(TOOL_BUDGETS.name + 1), description: "d", inputSchema: {} },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatch(/name is/);
  });

  it("catches an over-long description", () => {
    const violations = checkToolBudgets([
      { name: "ok", description: "d".repeat(TOOL_BUDGETS.description + 1), inputSchema: {} },
    ]);
    expect(violations[0]).toMatch(/description is/);
  });

  it("catches an over-long parameter description", () => {
    const violations = checkToolBudgets([
      {
        name: "ok",
        description: "d",
        inputSchema: {
          properties: { p: { description: "p".repeat(TOOL_BUDGETS.paramDescription + 1) } },
        },
      },
    ]);
    expect(violations[0]).toMatch(/ok\.p: description is/);
  });

  it("does not throw when a schema has no properties", () => {
    expect(checkToolBudgets([{ name: "ok", description: "d", inputSchema: {} }])).toEqual([]);
  });
});

describe("untrusted content shielding", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeModelContext();
    globalThis.document = { modelContext: ctx };
    registerMemoryBusTools();
  });

  it("wraps retrieve_relevant content in an untrusted envelope", async () => {
    const out = await ctx.registered.get("retrieve_relevant").spec.execute({ query: "q" });
    expect(out[0].content).toBe(
      "<untrusted-user-content>a stored observation</untrusted-user-content>",
    );
  });

  it("wraps get_working_memory content", async () => {
    const out = await ctx.registered.get("get_working_memory").spec.execute({ current_task: "t" });
    expect(out[0].content).toMatch(/^<untrusted-user-content>/);
  });

  it("wraps observations inside a summarize_context digest", async () => {
    const out = await ctx.registered.get("summarize_context").spec.execute({});
    expect(out.observations[0].content).toMatch(/^<untrusted-user-content>/);
    expect(out.observation_count).toBe(1);
  });

  it("leaves non-content fields of a digest untouched", async () => {
    const out = await ctx.registered.get("summarize_context").spec.execute({});
    expect(out.related_concept_links).toEqual([]);
  });

  it("wraps observations bundled with an explore_concepts result", async () => {
    const out = await ctx.registered.get("explore_concepts").spec.execute({ entity: "postgres" });
    expect(out.observations[0].content).toMatch(/^<untrusted-user-content>/);
  });

  it("leaves the graph shape of an explore_concepts result untouched", async () => {
    const out = await ctx.registered.get("explore_concepts").spec.execute({ entity: "postgres" });
    expect(out.nodes).toEqual([
      { name: "postgres", hops: 0 },
      { name: "rollback", hops: 1 },
    ]);
    expect(out.edges).toEqual([
      { entity1: "postgres", entity2: "rollback", relation: "requires", confidence: 1 },
    ]);
    expect(out.found).toBe(true);
  });

  it("truncates an oversized stored observation before it reaches the agent", async () => {
    retrieveRelevant.mockResolvedValueOnce([{ id: 9, content: "z".repeat(5000) }]);
    const out = await ctx.registered.get("retrieve_relevant").spec.execute({ query: "q" });
    expect(out[0].content.length).toBeLessThan(400);
    expect(out[0].content).toContain("[truncated]");
  });

  it("does not envelope the output of the write tools", async () => {
    const out = await ctx.registered.get("store_observation").spec.execute({ content: "hello" });
    expect(out.content).toBe("hello");
  });
});

describe("activity logging", () => {
  let ctx;

  beforeEach(() => {
    ctx = makeModelContext();
    globalThis.document = { modelContext: ctx };
    registerMemoryBusTools();
  });

  it("logs a successful call with its args and result", async () => {
    const events = [];
    const unsub = onToolActivity((e) => events.push(e));
    await ctx.registered.get("store_observation").spec.execute({ content: "hi" });
    unsub();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ name: "store_observation", ok: true });
    expect(events[0].args).toEqual({ content: "hi" });
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("logs a failure and rethrows so the agent sees the error", async () => {
    storeObservation.mockRejectedValueOnce(new Error("content is required"));
    const events = [];
    const unsub = onToolActivity((e) => events.push(e));
    await expect(
      ctx.registered.get("store_observation").spec.execute({}),
    ).rejects.toThrow("content is required");
    unsub();
    expect(events[0]).toMatchObject({ ok: false, error: "content is required" });
  });

  it("stringifies a non-Error rejection rather than logging undefined", async () => {
    storeObservation.mockRejectedValueOnce("plain string failure");
    const events = [];
    const unsub = onToolActivity((e) => events.push(e));
    await expect(ctx.registered.get("store_observation").spec.execute({})).rejects.toBeTruthy();
    unsub();
    expect(events[0].error).toBe("plain string failure");
  });

  it("defaults missing args to an empty object", async () => {
    await ctx.registered.get("store_observation").spec.execute();
    expect(storeObservation).toHaveBeenCalledWith({});
  });

  it("stops delivering events after unsubscribe", async () => {
    const events = [];
    onToolActivity((e) => events.push(e))();
    await ctx.registered.get("store_observation").spec.execute({ content: "hi" });
    expect(events).toHaveLength(0);
  });

  it("delivers to multiple subscribers", async () => {
    const a = [];
    const b = [];
    const unsubA = onToolActivity((e) => a.push(e));
    const unsubB = onToolActivity((e) => b.push(e));
    await ctx.registered.get("link_concepts").spec.execute({
      entity1: "x",
      entity2: "y",
      relation: "r",
    });
    unsubA();
    unsubB();
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
  });
});
