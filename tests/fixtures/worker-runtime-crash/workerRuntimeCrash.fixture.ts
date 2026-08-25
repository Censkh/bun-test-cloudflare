import { expect, test } from "bun:test";
import { startWorkerdCrashLoop } from "./captureWorkerdProcesses";
import { harness } from "./harness";

test("test teardown settles while the whole workerd pool repeatedly crashes", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://worker-runtime-crash.test/");

    expect(await response.text()).toBe("ok");
    const crashedProcessCount = startWorkerdCrashLoop();
    console.error(`[worker-runtime-crash] crashed workerd pool processes=${crashedProcessCount}`);
    expect(crashedProcessCount).toBeGreaterThan(1);
  });
});
