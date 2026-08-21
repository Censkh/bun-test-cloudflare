import { expect, test } from "bun:test";
import { harness } from "./harness";

const storageKey = "prewarmed-storage-reset";

test("reuses a Worker session with clean D1, KV, and R2 storage", async () => {
  await harness.run(async (workers) => {
    const env = await workers.WORKER.getEnv();
    await env.DB.prepare("CREATE TABLE entries (id TEXT PRIMARY KEY)").run();
    await env.DB.prepare("INSERT INTO entries (id) VALUES (?)").bind(storageKey).run();
    await env.KV.put(storageKey, "present");
    await env.DOCUMENTS.put(storageKey, "present");
  });

  await harness.run(async () => {});

  await harness.run(async (workers) => {
    const env = await workers.WORKER.getEnv();
    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
    ).first();

    expect(table).toBeNull();
    expect(await env.KV.get(storageKey)).toBeNull();
    expect(await env.DOCUMENTS.head(storageKey)).toBeNull();
  });
});
