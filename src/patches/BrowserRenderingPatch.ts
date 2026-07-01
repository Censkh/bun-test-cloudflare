import childProcess from "node:child_process";

const browserRenderingProfilePathPattern = /[/\\]miniflare-[^/\\]+[/\\]browser-rendering[/\\]profile-/;
const devtoolsEndpointPattern = /DevTools listening on ws:\/\//;
const pendingBrowserLaunches = new Set<Promise<void>>();

const isBrowserRenderingLaunch = (command: string, args?: readonly string[]) => {
  if (!command.includes("Chrome")) {
    return false;
  }

  return args?.some((arg) => arg.startsWith("--user-data-dir=") && browserRenderingProfilePathPattern.test(arg)) ?? false;
};

const trackBrowserLaunch = (child: childProcess.ChildProcess) => {
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

  const timeout = setTimeout(settle, 3_000);
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
  while (pendingBrowserLaunches.size > 0) {
    await Promise.allSettled([...pendingBrowserLaunches]);
  }
};

export const installBrowserRenderingPatch = () => {
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = function bunTestCloudflareSpawn(command: string, args?: readonly string[], options?: childProcess.SpawnOptions) {
    const child = originalSpawn.call(this, command, args as string[], options);

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
