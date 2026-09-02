import {
  storeObservation,
  retrieveRelevant,
  getWorkingMemory,
  linkConcepts,
  summarizeContext,
} from "./memoryStore";

const activityListeners = new Set();

export function onToolActivity(fn) {
  activityListeners.add(fn);
  return () => activityListeners.delete(fn);
}

function logActivity(entry) {
  for (const fn of activityListeners) fn(entry);
}

function wrap(name, handler) {
  return async (args) => {
    const startedAt = new Date().toISOString();
    try {
      const result = await handler(args || {});
      logActivity({ name, args, result, ok: true, at: startedAt });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logActivity({ name, args, error: message, ok: false, at: startedAt });
      throw err;
    }
  };
}

function getModelContext() {
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  return null;
}

export function isWebMCPAvailable() {
  return Boolean(getModelContext());
}

export function registerMemoryBusTools() {
  const modelContext = getModelContext();
  if (!modelContext) return false;

  modelContext.registerTool({
    name: "store_observation",
    description:
      "Store an observation (something read, decided, or noticed) into persistent browser-local memory, tagged with its source and time.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The text of the observation." },
        source_url: { type: "string", description: "URL the observation came from." },
        timestamp: { type: "string", description: "ISO timestamp; defaults to now." },
        tags: { type: "array", items: { type: "string" }, description: "Free-form topic tags." },
      },
      required: ["content"],
    },
    execute: wrap("store_observation", storeObservation),
  });

  modelContext.registerTool({
    name: "retrieve_relevant",
    description:
      "Semantic search over stored observations. Returns the observations most similar in meaning to the query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to search for." },
        task_context: { type: "string", description: "Extra context about the current task to bias retrieval." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["query"],
    },
    execute: wrap("retrieve_relevant", retrieveRelevant),
  });

  modelContext.registerTool({
    name: "get_working_memory",
    description:
      "Returns the most relevant recent observations for a current task, blending semantic similarity with recency.",
    inputSchema: {
      type: "object",
      properties: {
        current_task: { type: "string", description: "Description of what the user/agent is doing right now." },
        limit: { type: "number", description: "Max results (default 5)." },
      },
      required: ["current_task"],
    },
    execute: wrap("get_working_memory", getWorkingMemory),
  });

  modelContext.registerTool({
    name: "link_concepts",
    description: "Record a relation between two concepts/entities in the semantic memory graph.",
    inputSchema: {
      type: "object",
      properties: {
        entity1: { type: "string" },
        entity2: { type: "string" },
        relation: { type: "string", description: "How entity1 relates to entity2, e.g. 'causes', 'is a', 'blocks'." },
        confidence: { type: "number", description: "0-1 confidence score." },
      },
      required: ["entity1", "entity2", "relation"],
    },
    execute: wrap("link_concepts", linkConcepts),
  });

  modelContext.registerTool({
    name: "summarize_context",
    description:
      "Retrieve stored observations and concept links filtered by a time range and/or topic, for the caller to summarize.",
    inputSchema: {
      type: "object",
      properties: {
        time_range: {
          type: "object",
          properties: {
            start: { type: "string", description: "ISO date/time." },
            end: { type: "string", description: "ISO date/time." },
          },
        },
        topic_filter: { type: "string", description: "Keyword or tag to filter by." },
      },
    },
    execute: wrap("summarize_context", summarizeContext),
  });

  return true;
}
