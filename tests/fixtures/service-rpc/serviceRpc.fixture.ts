import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  workers: {
    CALLER: { configPath: path.join(import.meta.dir, "caller.toml"), name: "service-rpc-caller" },
    TARGET: { configPath: path.join(import.meta.dir, "target.toml"), name: "service-rpc-target" },
  },
});

test("a Worker calls another's RPC methods through its service binding, callbacks and all, in its slot", async () => {
  for (let run = 0; run < 3; run++)
    await harness.run(async (workers) => {
      for (const pathname of ["/", "/object"]) {
        const response = await workers.CALLER.fetch(`https://example.com${pathname}`);
        expect(await response.json()).toEqual({ described: "target: part1part2" });
      }
    });
});
