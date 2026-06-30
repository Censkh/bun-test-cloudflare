import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import {
  createAsyncOperationTracker,
  installRuntimeTeardownGuard,
  installWranglerPatches,
  platformProxyDispatchContext,
  trackPlatformProxyDispatch,
} from "../src/wranglerPatches";

const require = createRequire(import.meta.url);

test("tracks platform proxy dispatches until they finish", async () => {
  installWranglerPatches();
  const undici = require("undici") as { fetch: typeof fetch };
  const lifecycleEvents: string[] = [];
  let releaseBody!: () => void;
  let bodyStarted!: () => void;
  const bodyStartedPromise = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const bodyReleasePromise = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            lifecycleEvents.push("body-started");
            bodyStarted();
            void bodyReleasePromise.then(() => {
              controller.enqueue(new TextEncoder().encode("ok"));
              controller.close();
              lifecycleEvents.push("body-finished");
            });
          },
        }),
      );
    },
  });

  try {
    const tracker = createAsyncOperationTracker();
    await platformProxyDispatchContext.run(tracker, async () => {
      const url = `http://${server.hostname}:${server.port}/cdn-cgi/platform-proxy`;
      const responsePromise = trackPlatformProxyDispatch(url, undici.fetch(url));
      await bodyStartedPromise;

      let drained = false;
      const drainPromise = tracker.drain().then(() => {
        drained = true;
        lifecycleEvents.push("drained");
      });
      await Promise.resolve();
      expect(drained).toBe(false);

      releaseBody();
      const response = await responsePromise;
      expect(await response.text()).toBe("ok");
      await drainPromise;
    });

    expect(lifecycleEvents).toEqual(["body-started", "body-finished", "drained"]);
  } finally {
    await server.stop(true);
  }
});

test("guards shared Wrangler runtime teardown", async () => {
  let teardownCalls = 0;
  let releaseTeardown!: () => void;
  const teardownReleased = new Promise<void>((resolve) => {
    releaseTeardown = resolve;
  });
  const runtime = {
    async teardown() {
      teardownCalls++;
      await teardownReleased;
    },
  };

  installRuntimeTeardownGuard(runtime);
  installRuntimeTeardownGuard(runtime);

  const firstTeardown = runtime.teardown();
  const secondTeardown = runtime.teardown();

  expect(teardownCalls).toBe(1);
  expect(secondTeardown).toBe(firstTeardown);

  releaseTeardown();
  await Promise.all([firstTeardown, secondTeardown]);
  expect(teardownCalls).toBe(1);
});
