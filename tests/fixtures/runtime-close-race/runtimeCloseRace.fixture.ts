import { expect, test } from "bun:test";
import { harness } from "./harness";

test("runtime closes after an unconsumed platform proxy response", async () => {
  await harness.run(async (workers) => {
    const env = await workers.WORKER.getEnv();
    env.OTHER.fetch("https://runtime-close-race-other.test/pending").catch(() => {});
    expect(true).toBe(true);
  });
});
