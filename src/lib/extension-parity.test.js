/**
 * The companion extension declares the same five tools as the site so it can
 * register them on pages it does not control. That duplication is deliberate
 * — the extension cannot import the app's modules into a page's MAIN world —
 * but it means the two lists can silently drift, and an agent would then see
 * a different set of tools depending on which surface answered it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { TOOL_SPECS } from "./webmcpTools.js";

const extensionSource = readFileSync(
  fileURLToPath(new URL("../../extension/register-tools.js", import.meta.url)),
  "utf8",
);

const extensionToolNames = [...extensionSource.matchAll(/^\s{6}name: "([a-z_]+)",$/gm)].map(
  (m) => m[1],
);

describe("extension/site tool parity", () => {
  it("declares exactly the same tool names as the site", () => {
    expect(extensionToolNames.sort()).toEqual(TOOL_SPECS.map((t) => t.name).sort());
  });

  it("keeps every site tool's required parameters present in the extension copy", () => {
    for (const spec of TOOL_SPECS) {
      for (const required of spec.inputSchema.required ?? []) {
        expect(
          extensionSource.includes(`${required}:`),
          `extension is missing required param "${required}" of ${spec.name}`,
        ).toBe(true);
      }
    }
  });

  it("still exposes no tool capable of deleting memory", () => {
    expect(extensionToolNames.some((n) => /delete|clear|remove|wipe/i.test(n))).toBe(false);
  });
});
