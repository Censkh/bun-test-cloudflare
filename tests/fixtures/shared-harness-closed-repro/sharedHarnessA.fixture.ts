import { expect, test } from "bun:test";
import { harness } from "./harness";

test("first file uses the shared harness", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://worker.local/");
    expect(await response.text()).toBe("ok");
  });
});
