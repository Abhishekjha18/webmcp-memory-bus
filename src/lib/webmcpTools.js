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

/**
 * Chrome is mid-migration between the two namespaces. `document.modelContext`
 * is the current spec surface; `navigator.modelContext` is the older name
 * still shipping behind the flag in some builds, so it stays as a fallback.
 */
function getModelContext() {
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  return null;
}

export function isWebMCPAvailable() {
  return Boolean(getModelContext());
}

/**
 * Register all five tools.
 *
 * `signal` matters: the WebMCP spec has no `unregisterTool`, so an
 * AbortSignal is the only way to take a tool back down. React 19 StrictMode
 * double-invokes effects in development, and without this the second mount
 * would register a duplicate set of tools.
 *
 * `exposedTo` is deliberately omitted. These tools mutate the user's own
 * memory store; the default (agents interacting with this page) is the
 * intended audience, and an allowlist here would only widen that.
 */
export function registerMemoryBusTools({ signal } = {}) {
  const modelContext = getModelContext();
  if (!modelContext) return false;

  const options = signal ? { signal } : undefined;

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
  }, options);

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
  }, options);

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
  }, options);

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
  }, options);

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
  }, options);

  return true;
}
