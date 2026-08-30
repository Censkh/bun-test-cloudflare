import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  prewarmedWorkerdPoolSize: 1,
  workers: {
    TIKTOKEN: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "tiktoken-wasm-fixture",
    },
  },
});

test("loads tiktoken wasm independently in isolated Worker slots", async () => {
  const runInNextSlot = () =>
    harness.run(async (workers) => {
      const response = await workers.TIKTOKEN.fetch("https://example.com/count?text=hello%20world");
      expect(response.status).toBe(200);
      return response.json();
    });

  await expect(runInNextSlot()).resolves.toEqual({ instanceRequestCount: 1, tokenCount: 2, tokens: [15339, 1917] });
  await expect(runInNextSlot()).resolves.toEqual({ instanceRequestCount: 1, tokenCount: 2, tokens: [15339, 1917] });
});
