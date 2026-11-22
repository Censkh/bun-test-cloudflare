import { expect, test } from "bun:test";
import { harness } from "./harness";

// This one times out before its run starts: the broker is still starting.
test("a test that times out before its run starts", async () => {
  await harness.run(() => new Promise(() => {}));
}, 1);

// Each of these times out while its run is still going, one for each of the broker's two slots.
for (const name of ["first", "second"])
  test(`a ${name} test that times out mid-run`, async () => {
    await harness.run(() => new Promise(() => {}));
  }, 1_000);

// Their runs ended with their tests, so this one gets a slot.
test("a run after tests that timed out mid-run gets a slot", async () => {
  await harness.run(async (workers) => {
    expect((await workers.WORKER.fetch("https://example.com/")).status).toBe(200);
  });
}, 20_000);
