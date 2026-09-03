import { expect, test } from "bun:test";
import type childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { drainHarnessRun } from "../src/HarnessRunTeardown";
import {
  drainBrowserRenderingLaunches,
  isBrowserRenderingLaunch,
  trackBrowserLaunch,
  trackBrowserRenderingLaunchRequest,
} from "../src/patches/BrowserRenderingPatch";

const operationTracker = {
  drain: async () => {},
  track: <T>(promise: Promise<T>) => promise,
};

class FakeResponse extends EventEmitter {
  off(eventName: string, listener: (...args: any[]) => void) {
    return super.off(eventName, listener);
  }
}

test("browser launch detection ignores non-string spawn arguments", () => {
  expect(isBrowserRenderingLaunch("chrome", [{ detached: true }, "--user-data-dir=/tmp/profile"])).toBe(false);
  expect(isBrowserRenderingLaunch("chrome", ["--user-data-dir=/tmp/miniflare-test/browser-rendering/profile-1"])).toBe(
    true,
  );
});

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

test("timed out browser launches remain tracked until Chromium exits", async () => {
  const child = new EventEmitter() as childProcess.ChildProcess;
  child.stderr = new PassThrough();
  let killed = false;
  child.kill = () => {
    killed = true;
    return true;
  };

  trackBrowserLaunch(child, 1);
  const drain = drainBrowserRenderingLaunches();
  const result = await Promise.race([
    drain.then(() => "drained"),
    new Promise((resolve) => setTimeout(() => resolve("tracked"), 20)),
  ]);

  expect(killed).toBe(true);
  expect(result).toBe("tracked");

  child.emit("exit", null, "SIGTERM");
  await drain;
});
