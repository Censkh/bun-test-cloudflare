import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHarness, expectWorking } from "./harness";
import { settledWorkerdCount } from "./workerdProcesses";

// Bun runs an afterAll registered inside a beforeAll as soon as that hook returns, so a pool tied to
// the hook's own scope would close before the tests the hook prepared it for.

describe("a harness a beforeAll created", () => {
  let harness: ReturnType<typeof createHarness>;
  let server: Awaited<ReturnType<ReturnType<typeof createHarness>["serve"]>>;
  beforeAll(async () => {
    harness = createHarness();
    server = await harness.serve({ worker: "WORKER" });
  });
  afterAll(() => server.stop());

  test("serves the tests that follow the hook", async () => {
    const response = await server.workers.WORKER.fetch("https://scoped-harness-pools.test/");
    expect(await response.text()).toBe("ok");
  });
  test("still serves a later test", async () => {
    const response = await server.workers.WORKER.fetch("https://scoped-harness-pools.test/");
    expect(await response.text()).toBe("ok");
  });
  test("runs from the same harness", () => expectWorking(harness));
});

describe("a harness a beforeEach created", () => {
  let harness: ReturnType<typeof createHarness>;
  beforeEach(() => {
    harness = createHarness();
  });
  test("runs in its test", () => expectWorking(harness));
});

// The beforeAll harness's servers went idle when its block ended and closed once the beforeEach
// harness took a lease, so no workerd remains after that test.
test("the beforeEach harness's workerd stopped when its test ended", async () => {
  expect(await settledWorkerdCount()).toBe(0);
});
