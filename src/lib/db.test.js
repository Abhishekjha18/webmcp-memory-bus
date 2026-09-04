import { describe, it, expect, afterEach } from "vitest";
import { getStorageEstimate } from "./db";

// Node's built-in `navigator` global (where present) is a getter-only
// accessor property, so a plain `navigator = ...` or `globalThis.navigator
// = ...` assignment throws ("Cannot set property navigator ... which has
// only a getter") — it has to be replaced via defineProperty. Whether the
// global exists at all is also Node-version-dependent (this repo's CI
// pins Node 20, where the identifier can be entirely undefined, unlike
// newer Node versions), so nothing here assumes it's already declared.
function setNavigator(value) {
  Object.defineProperty(globalThis, "navigator", { value, configurable: true, writable: true });
}

const hadNavigator = typeof navigator !== "undefined";
const originalNavigator = hadNavigator ? navigator : undefined;

describe("getStorageEstimate", () => {
  afterEach(() => {
    if (hadNavigator) {
      setNavigator(originalNavigator);
    } else {
      delete globalThis.navigator;
    }
  });

  it("reports unsupported when navigator.storage.estimate is absent", async () => {
    // Whatever this environment's baseline navigator looks like, it has no
    // storage.estimate here — matching an older Safari or a browser's
    // private-browsing mode where the API is missing.
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: false });
  });

  it("reports usage and quota when the API is available", async () => {
    setNavigator({ storage: { estimate: async () => ({ usage: 123456, quota: 987654321 }) } });
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: true, usageBytes: 123456, quotaBytes: 987654321 });
  });

  it("defaults missing usage or quota fields to 0", async () => {
    setNavigator({ storage: { estimate: async () => ({}) } });
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: true, usageBytes: 0, quotaBytes: 0 });
  });

  it("degrades to unsupported if estimate() itself throws", async () => {
    setNavigator({
      storage: {
        estimate: async () => {
          throw new Error("denied");
        },
      },
    });
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: false });
  });
});
