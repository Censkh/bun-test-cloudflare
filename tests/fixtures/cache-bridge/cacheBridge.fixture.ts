import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "cache-bridge-fixture",
    },
  },
});

const getCaches = () => {
  const cacheStorage = (globalThis as typeof globalThis & { caches?: CacheStorage }).caches;
  if (!cacheStorage) throw new Error("globalThis.caches is not installed");
  return cacheStorage;
};

test("host and Worker cache operations share the same runtime cache", async () => {
  await harness.run(async (workers) => {
    const hostKey = "https://cache-bridge.test/from-host";
    const workerKey = "https://cache-bridge.test/from-worker";

    await getCaches().default.put(
      new Request(hostKey),
      new Response("host-value", { headers: { "Cache-Control": "max-age=60" } }),
    );

    const hostWrittenResponse = await workers.WORKER.fetch(`/cache/match?key=${encodeURIComponent(hostKey)}`);
    expect(hostWrittenResponse.status).toBe(200);
    expect(await hostWrittenResponse.text()).toBe("host-value");

    const workerWriteResponse = await workers.WORKER.fetch(
      `/cache/put?key=${encodeURIComponent(workerKey)}&value=worker-value`,
    );
    expect(workerWriteResponse.status).toBe(200);

    const workerWrittenResponse = await getCaches().default.match(new Request(workerKey));
    expect(workerWrittenResponse).toBeDefined();
    expect(await workerWrittenResponse?.text()).toBe("worker-value");
  });
});
