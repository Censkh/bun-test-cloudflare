import { expect, test } from "bun:test";
import { harness } from "./harness";

test("parallel build reused owner C", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/c");
    expect(await response.text()).toBe("ok");
  });
});
