import { expect, test } from "bun:test";
import "bun-test-cloudflare/setup";
import { harness } from "./harness";

const storageKey = "prewarmed-storage-reset";
const hostCacheKey = new Request("https://prewarmed-storage-reset.invalid/host-cache");

const expectCleanState = async () => {
  await harness.run(async (workers, server) => {
    const env = await workers.WORKER.getEnv();
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
    ).first();
    const workerState = (await (await server.fetch("https://example.com/state")).json()) as {
      cached: string | null;
      requestCount: number;
    };

    expect(table).toBeNull();
    expect(await env.KV.get(storageKey)).toBeNull();
    expect(await env.DOCUMENTS.head(storageKey)).toBeNull();
    expect(workerState).toEqual({ cached: null, requestCount: 1 });
    expect(await caches.default.match(hostCacheKey)).toBeUndefined();
  });
};

test("reuses isolated Worker slots with clean globals, caches, D1, KV, and R2", async () => {
  await harness.run(async (workers, server) => {
    const env = await workers.WORKER.getEnv();
    await env.DB.prepare("CREATE TABLE entries (id TEXT PRIMARY KEY)").run();
    await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind(storageKey).run();
    await env.KV.put(storageKey, "present");
    await env.DOCUMENTS.put(storageKey, "present");
    await caches.default.put(
      hostCacheKey,
      new Response("present", { headers: { "Cache-Control": "public, max-age=60" } }),
    );

    const workerState = await server.fetch("https://example.com/write-cache");
    expect(await workerState.json()).toEqual({ cached: "present", requestCount: 1 });
    expect(await (await caches.default.match(hostCacheKey))?.text()).toBe("present");
  });

  await harness.run(async () => {});
  await expectCleanState();
  await harness.run(async () => {});
  await expectCleanState();
});
