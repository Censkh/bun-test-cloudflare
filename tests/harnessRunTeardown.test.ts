import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { drainHarnessRun } from "../src/HarnessRunTeardown";
import { drainBrowserRenderingLaunches, trackBrowserRenderingLaunchRequest } from "../src/patches/BrowserRenderingPatch";

const operationTracker = {
  drain: async () => {},
  track: <T>(promise: Promise<T>) => promise,
};

class FakeResponse extends EventEmitter {
  off(eventName: string, listener: (...args: any[]) => void) {
    return super.off(eventName, listener);
  }
}

test("non-browser harness cleanup does not wait on unrelated browser launches", async () => {
  const response = new FakeResponse();
  trackBrowserRenderingLaunchRequest(response as any);

  const result = await Promise.race([
    drainHarnessRun({
      devEnvs: [],
      drainBrowserRendering: false,
      platformProxyDispatches: operationTracker,
    }).then(() => "drained"),
    new Promise((resolve) => setTimeout(() => resolve("blocked"), 50)),
  ]);

  expect(result).toBe("drained");

  response.emit("finish");
  await drainBrowserRenderingLaunches();
});

