import { expect, test } from "bun:test";
import { harness } from "./harness";
import { freezeEsbuildServices, killLiveWorkerdProcesses, thawEsbuildServices } from "./workerdProcesses";

// Bun kills every child process when a test times out, so later runs must not reuse a dead runtime
// or a dead esbuild service, and a run whose runtime dies must fail instead of waiting forever.

const expectWorking = () =>
  harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://runtime-kill-recovery.test/");
    expect(await response.text()).toBe("ok");
    const env = (await workers.WORKER.getEnv()) as any;
    const counter = env.COUNTER.get(env.COUNTER.idFromName(crypto.randomUUID()));
    expect(await counter.increment()).toBe(1);
  });

test("works before any runtime is killed", expectWorking);

test("fails a run at once when its runtime is killed", async () => {
  const run = harness.run(async () => {
    expect(killLiveWorkerdProcesses()).toBeGreaterThan(0);
    await new Promise(() => {});
  });
  await expect(run).rejects.toMatchObject({ code: "ERR_WORKER_RUNTIME_CRASHED" });
});

test("starts a new runtime for the next run", expectWorking);

test("replaces a pooled runtime killed between runs", async () => {
  await expectWorking();
  expect(killLiveWorkerdProcesses()).toBeGreaterThan(0);
  await expectWorking();
});

test("crosses a workerd generation reset while esbuild's service answers nothing", async () => {
  expect(freezeEsbuildServices()).toBeGreaterThan(0);
  try {
    // More runs than the four slots of a generation, within less than the stalled-probe deadline.
    for (let run = 0; run < 6; run++) await expectWorking();
  } finally {
    thawEsbuildServices();
  }
}, 8_000);

test("BUN TIMEOUT", () => harness.run(() => new Promise(() => {})), 2_000);

for (let index = 0; index < 5; index++) {
  test(`works after a Bun test timeout ${index}`, expectWorking);
}
