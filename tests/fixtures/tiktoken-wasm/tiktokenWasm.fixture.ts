import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    TIKTOKEN: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "tiktoken-wasm-fixture",
    },
  },
});

test("loads tiktoken wasm inside a Worker", async () => {
  await harness.run(async (workers) => {
    const response = await workers.TIKTOKEN.fetch("https://example.com/count?text=hello%20world");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ tokenCount: 2, tokens: [15339, 1917] });
  });
});
