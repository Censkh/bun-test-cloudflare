import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  workers: { WORKER: { configPath: path.join(import.meta.dir, "wrangler.toml"), name: "large-modules" } },
});

test("a Worker whose module is larger than an RPC value runs in its slot, whole", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/");
    expect(await response.json()).toEqual({ size: Number(process.env.LARGE_MODULE_BYTES), first: "<", last: ">" });
  });
});
