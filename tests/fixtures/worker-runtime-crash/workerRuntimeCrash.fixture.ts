import { expect, test } from "bun:test";
import { startWorkerdCrashLoop } from "./captureWorkerdProcesses";
import { harness } from "./harness";

test("test teardown settles while the whole workerd pool repeatedly crashes", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://worker-runtime-crash.test/");

    expect(await response.text()).toBe("ok");
    expect(startWorkerdCrashLoop()).toBeGreaterThan(1);
  });
});
