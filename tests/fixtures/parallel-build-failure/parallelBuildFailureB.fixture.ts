import { expect, test } from "bun:test";
import { harness } from "./harness";

test("parallel build failure B", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/b");
    expect(await response.text()).toBe("ok");
  });
});
