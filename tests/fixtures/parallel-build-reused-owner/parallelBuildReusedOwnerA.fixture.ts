import { expect, test } from "bun:test";
import { harness } from "./harness";

test("parallel build reused owner A", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://example.com/a");
    expect(await response.text()).toBe("ok");
  });
});
