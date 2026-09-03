/**
 * Defenses against indirect prompt injection.
 *
 * Threat: `content` stored via `store_observation` can originate from any
 * page an agent visited. That text is later replayed verbatim into a future
 * agent's context by `retrieve_relevant`, `get_working_memory`, and
 * `summarize_context` — the same attack shape the WebMCP spec warns about,
 * where a field carries a hidden "ignore your instructions" payload that
 * was never meant for a human to act on.
 *
 * IMPORTANT: unlike a system with a server-enforced ceiling, nothing here
 * is a hard backstop — these tools only ever read/write a local, per-origin
 * IndexedDB database. There is no privileged action a tool can take (no
 * money, no external side effects), so the realistic worst case of a
 * successful injection is a corrupted or misleading memory, not a loss.
 * These functions reduce that blast radius; see docs/SECURITY.md.
 */

/** Patterns suggesting someone is trying to smuggle instructions to an agent. */
const INJECTION_SIGNATURES = [
  /<\s*\/?\s*(important|system|instruction|assistant|user|tool)\b/i,
  /\b(ignore|disregard|override|forget)\b[^.]{0,40}\b(previous|prior|above|earlier|your)\b/i,
  /\byou\s+(must|should|are\s+required\s+to)\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)/i,
  /```/,
  /\[\s*INST\s*\]/i,
];

/**
 * Codepoints that hide a payload from a human reviewer while still
 * reaching a model: C0/C1 controls, zero-width characters, bidi overrides.
 *
 * Implemented as a codepoint predicate rather than a regex character
 * class — control characters embedded literally in source are fragile to
 * copy/paste and easy to get subtly wrong.
 */
function isHiddenChar(cp) {
  // Tab, newline and carriage return are legitimate structure in a stored
  // observation — unlike a single-line display name, prose loses meaning
  // without them, and they carry no concealment value.
  if (cp === 0x09 || cp === 0x0a || cp === 0x0d) return false;
  if (cp <= 0x1f) return true; // remaining C0 controls
  if (cp === 0x7f) return true; // DEL
  if (cp >= 0x80 && cp <= 0x9f) return true; // C1 controls
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d) return true; // ZWSP/ZWNJ/ZWJ
  if (cp === 0xfeff) return true; // BOM / zero-width no-break space
  if (cp === 0x202a || cp === 0x202e) return true; // bidi embedding/override
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  return false;
}

function stripHidden(raw) {
  return Array.from(raw)
    .filter((ch) => !isHiddenChar(ch.codePointAt(0)))
    .join("");
}

/**
 * Scan text for injection-style phrasing. Does not modify the text —
 * stored content is a legitimate memory of what an agent read, so it is
 * flagged rather than mutated or rejected. Silently altering someone's
 * observation would make the memory store lie about what was actually
 * seen.
 */
export function scanForInjection(raw) {
  if (typeof raw !== "string") return false;
  return INJECTION_SIGNATURES.some((re) => re.test(raw));
}

/** Strip hidden/control codepoints from text before it is ever displayed or embedded. */
export function sanitizeText(raw) {
  if (typeof raw !== "string") return raw;
  return stripHidden(raw);
}

/**
 * Wrap untrusted values in an explicit envelope before they reach an
 * agent's context. Structural framing matters: an agent told a value is
 * `<untrusted-user-content>...</untrusted-user-content>` has a far better
 * chance of treating the contents as data than the same string
 * interpolated as bare prose.
 */
export function untrustedEnvelope(value) {
  return `<untrusted-user-content>${value}</untrusted-user-content>`;
}

/**
 * Hard cap on tool output size. Chrome's secure-tools guidance gives a
 * provisional budget of ~1.5K characters per tool output; oversized tool
 * text measurably degrades agent guardrails.
 */
export const MAX_TOOL_OUTPUT_CHARS = 1500;

export function boundOutput(text, max = MAX_TOOL_OUTPUT_CHARS) {
  if (typeof text !== "string") return text;
  if (text.length <= max) return text;
  return text.slice(0, Math.max(0, max - 12)) + "…[truncated]";
}
