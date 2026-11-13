import { describe, expect, test } from "bun:test";
import { createHarness, expectWorking, sharedHarness } from "./harness";
import { settledWorkerdCount } from "./workerdProcesses";

// Bun runs every file in one process, so a pool that outlived the scope that created its harness
// would keep its workerd running through every later file.

test("a harness created in a test runs", async () => {
  await expectWorking(createHarness());
  expect(await settledWorkerdCount()).toBeGreaterThan(0);
});

test("its workerd stops when that test ends", async () => {
  expect(await settledWorkerdCount()).toBe(0);
});

describe("a harness created in a describe block", () => {
  const harness = createHarness();
  test("runs", () => expectWorking(harness));
  test("runs again from the same pool", () => expectWorking(harness));
});

test("its workerd stops when the block ends", async () => {
  expect(await settledWorkerdCount()).toBe(0);
});

test("a harness a shared module created runs", () => expectWorking(sharedHarness));
