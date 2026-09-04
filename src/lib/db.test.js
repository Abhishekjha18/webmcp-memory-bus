import { describe, it, expect, afterEach } from "vitest";
import { getStorageEstimate } from "./db";

describe("getStorageEstimate", () => {
  afterEach(() => {
    delete navigator.storage;
  });

  it("reports unsupported when navigator.storage.estimate is absent", async () => {
    // Node's built-in `navigator` global (no `storage` property) already
    // exercises this branch without any setup, matching an older Safari
    // or a browser's private-browsing mode where the API is missing.
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: false });
  });

  it("reports usage and quota when the API is available", async () => {
    navigator.storage = { estimate: async () => ({ usage: 123456, quota: 987654321 }) };
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: true, usageBytes: 123456, quotaBytes: 987654321 });
  });

  it("defaults missing usage or quota fields to 0", async () => {
    navigator.storage = { estimate: async () => ({}) };
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: true, usageBytes: 0, quotaBytes: 0 });
  });

  it("degrades to unsupported if estimate() itself throws", async () => {
    navigator.storage = {
      estimate: async () => {
        throw new Error("denied");
      },
    };
    const result = await getStorageEstimate();
    expect(result).toEqual({ supported: false });
  });
});
