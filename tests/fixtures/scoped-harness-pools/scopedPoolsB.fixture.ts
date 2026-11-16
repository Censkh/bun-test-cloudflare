import { expect, test } from "bun:test";
import { expectWorking, sharedHarness } from "./harness";
import { settledWorkerdCount } from "./workerdProcesses";

// Bun runs these files in one process sharing one global, so the shared harness's pool outlives
// the file that created it, for this one.

test("the shared harness's workerd keeps running for the next file", async () => {
  expect(await settledWorkerdCount()).toBeGreaterThan(0);
});

test("the shared harness runs in a later file from the pool it kept", async () => {
  const before = await settledWorkerdCount();
  await expectWorking(sharedHarness);
  expect(await settledWorkerdCount()).toBe(before);
});
