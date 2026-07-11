import { drainBrowserRenderingLaunches } from "./patches/BrowserRenderingPatch";
import { drainMiniflareLoopbackRequests } from "./patches/MiniflareLoopbackPatch";
import type { AsyncOperationTracker, CapturedDevEnv } from "./wranglerPatches";
import { drainDevEnvRuntimeMessages } from "./wranglerPatches";

type DrainHarnessRunOptions = {
  devEnvs: CapturedDevEnv[];
  drainBrowserRendering: boolean;
  platformProxyDispatches: AsyncOperationTracker;
};

// Worker responses can resolve before ctx.waitUntil() work has dispatched its
// follow-up loopback fetches. Give those tasks one macrotask turn to become
// visible to the drain trackers before closing the Miniflare server.
const allowRuntimeFollowUpWorkToStart = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const debugCleanup = async <T>(step: string, task: () => Promise<T>) => {
  if (!process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
    return task();
  }

  const start = Date.now();
  console.error(`[bun-test-cloudflare] cleanup:${step}:start`);
  try {
    return await task();
  } finally {
    console.error(`[bun-test-cloudflare] cleanup:${step}:end ${Date.now() - start}ms`);
  }
};

const drainBrowserRenderingWork = async (enabled: boolean) => {
  if (!enabled) {
    return;
  }

  await debugCleanup("drain-browser-loopback", drainMiniflareLoopbackRequests);
  await debugCleanup("drain-browser-launches", drainBrowserRenderingLaunches);
};

export const drainHarnessRun = async ({
  devEnvs,
  drainBrowserRendering,
  platformProxyDispatches,
}: DrainHarnessRunOptions) => {
  await debugCleanup("allow-follow-up-1", allowRuntimeFollowUpWorkToStart);
  await debugCleanup("drain-runtime-messages-1", () => drainDevEnvRuntimeMessages(devEnvs));
  await debugCleanup("drain-platform-proxy", () => platformProxyDispatches.drain());

  // Platform-proxy calls and runtime waitUntil work can enqueue Miniflare
  // loopback requests. Browser Rendering launch is one of those loopback paths,
  // and it is only safe to close the harness after the launch request has
  // produced a tracked Chrome process or finished.
  await drainBrowserRenderingWork(drainBrowserRendering);
  await debugCleanup("allow-follow-up-2", allowRuntimeFollowUpWorkToStart);
  await debugCleanup("drain-runtime-messages-2", () => drainDevEnvRuntimeMessages(devEnvs));
  await drainBrowserRenderingWork(drainBrowserRendering);
};
