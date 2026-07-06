import { drainBrowserRenderingLaunches } from "./patches/BrowserRenderingPatch";
import { drainMiniflareLoopbackRequests } from "./patches/MiniflareLoopbackPatch";
import type { AsyncOperationTracker, CapturedDevEnv } from "./wranglerPatches";
import { drainDevEnvRuntimeMessages } from "./wranglerPatches";

type DrainHarnessRunOptions = {
  devEnvs: CapturedDevEnv[];
  platformProxyDispatches: AsyncOperationTracker;
};

// Worker responses can resolve before ctx.waitUntil() work has dispatched its
// follow-up loopback fetches. Give those tasks one macrotask turn to become
// visible to the drain trackers before closing the Miniflare server.
const allowRuntimeFollowUpWorkToStart = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const drainHarnessRun = async ({ devEnvs, platformProxyDispatches }: DrainHarnessRunOptions) => {
  await allowRuntimeFollowUpWorkToStart();
  await drainDevEnvRuntimeMessages(devEnvs);
  await platformProxyDispatches.drain();

  // Platform-proxy calls and runtime waitUntil work can enqueue Miniflare
  // loopback requests. Browser Rendering launch is one of those loopback paths,
  // and it is only safe to close the harness after the launch request has
  // produced a tracked Chrome process or finished.
  await drainMiniflareLoopbackRequests();
  await drainBrowserRenderingLaunches();
  await allowRuntimeFollowUpWorkToStart();
  await drainDevEnvRuntimeMessages(devEnvs);
  await drainMiniflareLoopbackRequests();
  await drainBrowserRenderingLaunches();
};
