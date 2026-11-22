import { expect, test } from "bun:test";
import { getCloudflareHarnessRunContext } from "bun-test-cloudflare";
import { harness, truncateHarness } from "./harness";

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
    };

    expect(table).toBeNull();
    expect(await env.KV.get(storageKey)).toBeNull();
    expect(await env.DOCUMENTS.head(storageKey)).toBeNull();
    expect(workerState).toEqual({ cached: null });
    expect(await caches.default.match(hostCacheKey)).toBeUndefined();
  });
};

test("reuses isolated Worker slots with clean caches, D1, KV, and R2", async () => {
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
    expect(await workerState.json()).toEqual({ cached: "present" });
    expect(await (await caches.default.match(hostCacheKey))?.text()).toBe("present");
  });

  await harness.run(async () => {});
  await expectCleanState();
  await harness.run(async () => {});
  await expectCleanState();
});

test("a finished run's dispatch handles cannot mutate the next run", async () => {
  const resume = Promise.withResolvers<void>();
  const finished = await harness.run(async (workers, server) => {
    expect((await workers.WORKER.fetch("https://example.com/state")).ok).toBe(true);
    const lateDispatch = resume.promise.then(() =>
      getCloudflareHarnessRunContext().server.fetch("https://example.com/write-cache"),
    );
    return { worker: workers.WORKER, server, lateDispatch };
  });

  await harness.run(async (_workers, server) => {
    await expect(finished.worker.fetch("https://example.com/write-cache")).rejects.toHaveProperty(
      "name",
      "CloudflareHarnessRunEnded",
    );
    await expect(finished.server.fetch("https://example.com/write-cache")).rejects.toHaveProperty(
      "name",
      "CloudflareHarnessRunEnded",
    );
    await expect(finished.server.getWorker().fetch("https://example.com/write-cache")).rejects.toHaveProperty(
      "name",
      "CloudflareHarnessRunEnded",
    );
    resume.resolve();
    await expect(finished.lateDispatch).rejects.toHaveProperty("name", "CloudflareHarnessRunEnded");
    expect(await (await server.fetch("https://example.com/state")).json()).toEqual({ cached: null });
  });
});

test("d1ResetMode truncate preserves tables while clearing rows, foreign-key children, and autoincrement sequences", async () => {
  await truncateHarness.run(async (workers) => {
    const { DB } = await workers.WORKER.getEnv();
    await DB.batch([
      DB.prepare("CREATE TABLE parents (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)"),
      DB.prepare("CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parents(id))"),
    ]);
    await DB.prepare("INSERT INTO parents (name) VALUES (?)").bind("first").run();
    await DB.prepare("INSERT INTO children (id, parent_id) VALUES (?, ?)").bind(10, 1).run();
  });

  // Rotate through slot 1 so the next run reuses slot 0 after background truncate.
  await truncateHarness.run(async () => {});

  await truncateHarness.run(async (workers) => {
    const { DB } = await workers.WORKER.getEnv();
    const tables = await DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('parents', 'children') ORDER BY name",
    ).all<{ name: string }>();
    expect(tables.results.map((r) => r.name)).toEqual(["children", "parents"]);

    const parentCount = await DB.prepare("SELECT COUNT(*) AS count FROM parents").first<{ count: number }>();
    const childCount = await DB.prepare("SELECT COUNT(*) AS count FROM children").first<{ count: number }>();
    expect(parentCount?.count).toBe(0);
    expect(childCount?.count).toBe(0);

    const inserted = await DB.prepare("INSERT INTO parents (name) VALUES (?) RETURNING id")
      .bind("second")
      .first<{ id: number }>();
    expect(inserted?.id).toBe(1);
  });
});
