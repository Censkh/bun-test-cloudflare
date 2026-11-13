import { expect } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

export const createHarness = () =>
  createCloudflareHarness({
    workers: {
      WORKER: {
        configPath: path.join(import.meta.dir, "wrangler.toml"),
        name: "scoped-harness-pools",
      },
    },
  });

/** A harness that several files import, created while the first of them loads. */
export const sharedHarness = createHarness();

export const expectWorking = (harness: ReturnType<typeof createHarness>) =>
  harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://scoped-harness-pools.test/");
    expect(await response.text()).toBe("ok");
  });
