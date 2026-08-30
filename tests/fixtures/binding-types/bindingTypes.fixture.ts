import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

type BindingEnv = {
  ANALYTICS: AnalyticsEngineDataset;
  ASSETS: Fetcher;
  COUNTER: DurableObjectNamespace;
  DB: D1Database;
  EMAIL: SendEmail;
  HYPERDRIVE: Hyperdrive;
  JSON_VALUE: { enabled: boolean };
  KV: KVNamespace;
  QUEUE: Queue;
  RATE_LIMIT: RateLimit;
  R2: R2Bucket;
  SECRET_VALUE: string;
  SERVICE: Fetcher;
  TEXT_VALUE: string;
  VERSION: WorkerVersionMetadata;
  WORKFLOW: Workflow;
};

const harness = createCloudflareHarness({
  workers: {
    BINDINGS: {
      bindings: typeToken<BindingEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "binding-types-fixture",
      secrets: { SECRET_VALUE: "fixture-secret" },
    },
    SERVICE: {
      configPath: path.join(import.meta.dir, "wrangler.service.toml"),
      name: "binding-types-service",
    },
  },
});

type SlottedBindingEnv = {
  COUNTER: DurableObjectNamespace;
  DB: D1Database;
  IMAGES: ImagesBinding;
  JSON_VALUE: { enabled: boolean };
  KV: KVNamespace;
  R2: R2Bucket;
  SECRET_VALUE: string;
  SERVICE: Fetcher;
  TEXT_VALUE: string;
};

const slottedHarness = createCloudflareHarness({
  isolatedWorkerSlots: 4,
  prewarmedWorkerdPoolSize: 1,
  workers: {
    SERVICE: {
      configPath: path.join(import.meta.dir, "wrangler.slot-service.toml"),
      name: "binding-types-slot-service",
    },
    SLOTTED: {
      bindings: typeToken<SlottedBindingEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.slotted.toml"),
      name: "binding-types-slotted",
      secrets: { SECRET_VALUE: "slot-secret" },
    },
  },
});

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

describe("locally simulated Cloudflare bindings", () => {
  test("exposes value, storage, and service bindings", async () => {
    await harness.run(async (workers) => {
      const env = await workers.BINDINGS.getEnv();

      expect(env.TEXT_VALUE).toBe("fixture-value");
      expect(env.JSON_VALUE).toEqual({ enabled: true });
      expect(env.SECRET_VALUE).toBe("fixture-secret");

      await env.KV.put("key", "kv-value");
      expect(await env.KV.get("key")).toBe("kv-value");

      await env.R2.put("key", "r2-value");
      expect(await (await env.R2.get("key"))?.text()).toBe("r2-value");

      await env.DB.prepare("CREATE TABLE entries (value TEXT NOT NULL)").run();
      await env.DB.prepare("INSERT INTO entries (value) VALUES (?)").bind("d1-value").run();
      expect(await env.DB.prepare("SELECT value FROM entries").first("value")).toBe("d1-value");

      expect(await (await env.SERVICE.fetch("https://service.invalid/")).text()).toBe("service-value");

      const counter = env.COUNTER.get(env.COUNTER.idFromName("fixture"));
      expect(await (await counter.fetch("https://counter.invalid/")).json()).toEqual({ count: 1 });
      expect(await (await counter.fetch("https://counter.invalid/")).json()).toEqual({ count: 2 });
    });
  });

  test("exposes platform utility bindings", async () => {
    await harness.run(async (workers) => {
      const env = await workers.BINDINGS.getEnv();

      expect(
        await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'").first(),
      ).toBeNull();
      expect(await env.KV.get("key")).toBeNull();
      expect(await env.R2.head("key")).toBeNull();
      const counter = env.COUNTER.get(env.COUNTER.idFromName("fixture"));
      expect(await (await counter.fetch("https://counter.invalid/")).json()).toEqual({ count: 1 });

      expect(await (await env.ASSETS.fetch("https://assets.invalid/fixture.txt")).text()).toBe("asset-value\n");
      expect(env.HYPERDRIVE.connectionString).toBe("postgres://user:password@127.0.0.1:5432/database");
      expect(typeof env.EMAIL.send).toBe("function");
      await env.EMAIL.send({
        from: "sender@example.com",
        subject: "Binding fixture",
        text: "email-value",
        to: "recipient@example.com",
      });
      expect(typeof env.QUEUE.send).toBe("function");
      expect(typeof env.QUEUE.sendBatch).toBe("function");
      await env.QUEUE.send({ source: "binding-types" });

      expect(
        env.ANALYTICS.writeDataPoint({ blobs: ["fixture"], doubles: [1], indexes: ["binding-types"] }),
      ).toBeUndefined();
      expect(await env.RATE_LIMIT.limit({ key: "fixture" })).toEqual({ success: true });
      expect(typeof env.VERSION.id).toBe("string");
      const workflow = await env.WORKFLOW.create({
        id: `binding-types-${crypto.randomUUID()}`,
        params: { source: "binding-types" },
      });
      expect(workflow.id).toStartWith("binding-types-");
      expect(["complete", "queued", "running", "waiting"]).toContain((await workflow.status()).status);
    });
  });
});

test("rotates every slot-eligible binding through a complete prewarmed generation", async () => {
  for (let run = 0; run < 5; run += 1) {
    await slottedHarness.run(async (workers) => {
      const env = await workers.SLOTTED.getEnv();
      const table = await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'entries'",
      ).first();

      expect(table).toBeNull();
      expect(await env.KV.get("key")).toBeNull();
      expect(await env.R2.head("key")).toBeNull();
      expect(env.TEXT_VALUE).toBe("slot-value");
      expect(env.JSON_VALUE).toEqual({ enabled: true });
      expect(env.SECRET_VALUE).toBe("slot-secret");
      expect(await env.IMAGES.info(new Response(png1x1).body!)).toEqual(
        expect.objectContaining({ format: "image/png", height: 1, width: 1 }),
      );

      const counter = env.COUNTER.get(env.COUNTER.idFromName("fixture"));
      expect(await (await counter.fetch("https://counter.invalid/")).json()).toEqual({ count: 1 });
      expect(await (await workers.SLOTTED.fetch("https://slotted.invalid/state")).json()).toEqual({
        requestCount: 1,
        serviceRequestCount: 1,
      });

      await env.DB.prepare("CREATE TABLE entries (value TEXT NOT NULL)").run();
      await env.DB.prepare("INSERT INTO entries (value) VALUES (?)").bind(`run-${run}`).run();
      await env.KV.put("key", `run-${run}`);
      await env.R2.put("key", `run-${run}`);
    });
  }
});
