import childProcess from "node:child_process";
import type http from "node:http";

const browserRenderingProfilePathPattern = /[/\\]miniflare-[^/\\]+[/\\]browser-rendering[/\\]profile-/;
const devtoolsEndpointPattern = /DevTools listening on ws:\/\//;
const browserLaunchStartupTimeoutMs = 15_000;
const pendingBrowserLaunches = new Set<Promise<void>>();
const pendingBrowserLaunchRequests = new Set<Promise<void>>();
const pendingBrowserLaunchRequestSettlers: Array<() => void> = [];

const isBrowserRenderingLaunch = (_command: string, args?: readonly string[]) => {
  return (
    args?.some((arg) => arg.startsWith("--user-data-dir=") && browserRenderingProfilePathPattern.test(arg)) ?? false
  );
};

const settleOneBrowserLaunchRequest = () => {
  pendingBrowserLaunchRequestSettlers.shift()?.();
};

export const trackBrowserRenderingLaunchRequest = (response: http.ServerResponse) => {
  let settled = false;
  let settle!: () => void;
  const request = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      response.off("close", settle);
      response.off("finish", settle);
      const index = pendingBrowserLaunchRequestSettlers.indexOf(settle);
      if (index >= 0) {
        pendingBrowserLaunchRequestSettlers.splice(index, 1);
      }
      resolve();
    };

    pendingBrowserLaunchRequestSettlers.push(settle);
    response.once("close", settle);
    response.once("finish", settle);
  });
  // /browser/launch may wait a long time for Chrome to print DevTools output.
  // For close safety we only need to know that the launch reached child spawn;
  // trackBrowserLaunch() then waits for DevTools, exit, error, or its timeout.
  const timeout = setTimeout(settle, 10_000);
  timeout.unref?.();

  pendingBrowserLaunchRequests.add(request);
  request.finally(() => pendingBrowserLaunchRequests.delete(request)).catch(() => {});
};

const trackBrowserLaunch = (child: childProcess.ChildProcess) => {
  settleOneBrowserLaunchRequest();

  let settled = false;
  let bufferedStderr = "";
  let resolveLaunch!: () => void;
  const launch = new Promise<void>((resolve) => {
    resolveLaunch = resolve;
  });

  const settle = () => {
    if (settled) return;
    settled = true;
    pendingBrowserLaunches.delete(launch);
    resolveLaunch();
  };

  const timeout = setTimeout(settle, browserLaunchStartupTimeoutMs);
  const settleWithCleanup = () => {
    clearTimeout(timeout);
    settle();
  };

  child.stderr?.on("data", (chunk) => {
    bufferedStderr += chunk.toString();
    const lines = bufferedStderr.split(/\r?\n/);
    bufferedStderr = lines.pop() ?? "";

    if (lines.some((line) => devtoolsEndpointPattern.test(line))) {
      settleWithCleanup();
    }
  });
  child.once("exit", settleWithCleanup);
  child.once("error", settleWithCleanup);

  pendingBrowserLaunches.add(launch);
};

export const drainBrowserRenderingLaunches = async () => {
  while (pendingBrowserLaunchRequests.size > 0 || pendingBrowserLaunches.size > 0) {
    await Promise.allSettled([...pendingBrowserLaunchRequests, ...pendingBrowserLaunches]);
  }
};

export const installBrowserRenderingPatch = () => {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function bunTestCloudflareSpawn(
    this: unknown,
    command: string,
    args?: readonly string[],
    options?: childProcess.SpawnOptions,
  ) {
    const child = originalSpawn.call(this as any, command, args as string[], options as any);

    // Miniflare registers Browser Rendering sessions only after Chrome prints
    // the DevTools endpoint. If a test closes the harness while Chrome is still
    // starting, Miniflare can delete the temp profile directory underneath it,
    // which surfaces as Chromium's "SingletonLock: No such file or directory".
    if (isBrowserRenderingLaunch(command, args)) {
      trackBrowserLaunch(child);
    }

    return child;
  } as typeof childProcess.spawn;
};
