import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "wrangler-start-timeout-repro",
    },
  },
});

const waitForStartedRun = () => {
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });

  const run = harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/");
    expect(await response.text()).toBe("ok");
    resolveStarted();
    await new Promise(() => {});
  });

  run.catch(() => {});
  return started;
};

test("cleanup can close an abandoned Wrangler run", async () => {
  await waitForStartedRun();
});

test("Wrangler can start again after the previous run was abandoned", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/");
    expect(await response.text()).toBe("ok");
  });
});
