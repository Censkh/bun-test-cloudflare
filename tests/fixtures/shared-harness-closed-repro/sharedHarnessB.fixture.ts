import { expect, test } from "bun:test";
import { harness } from "./harness";

test("second file uses the same shared harness after the first file finishes", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://worker.local/");
    expect(await response.text()).toBe("ok");
  });
});
