import { expect, test } from "bun:test";
import { harness } from "./workerHarness";

test("a second file serves the shared harness's Workers", async () => {
  await harness.run(async (workers) => {
    expect(await (await workers.BACKEND.fetch("https://example.com/")).text()).toBe("backend-ok");
  });
});
