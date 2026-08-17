import { expect, test } from "bun:test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createAsyncOperationTracker,
  disposeCapturedMiniflareRuntimes,
  platformProxyDispatchContext,
  trackPlatformProxyDispatch,
} from "../src/wranglerPatches";

test("tracks platform proxy dispatches until they finish", async () => {
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
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-length": "2" });
    response.flushHeaders();
    lifecycleEvents.push("body-started");
    bodyStarted();
    void bodyReleasePromise.then(() => {
      response.end("ok");
      lifecycleEvents.push("body-finished");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const tracker = createAsyncOperationTracker();
    await platformProxyDispatchContext.run(tracker, async () => {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/cdn-cgi/platform-proxy`;
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
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

test("disposes captured Miniflare runtimes after Wrangler close", async () => {
  const disposed: string[] = [];

  await disposeCapturedMiniflareRuntimes([
    {
      runtimes: [
        {
          mf: {
            dispose: async () => {
              disposed.push("first");
            },
          },
        },
        {},
      ],
    },
    {
      runtimes: [
        {
          mf: {
            dispose: () => {
              disposed.push("second");
            },
          },
        },
      ],
    },
  ]);

  expect(disposed.sort()).toEqual(["first", "second"]);
});
