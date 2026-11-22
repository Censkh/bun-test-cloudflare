import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  createRunCacheStorage,
  createRunD1Binding,
  createRunR2Binding,
  dispatchRunQueue,
  executeRunCacheOperation,
  executeRunD1Operation,
  executeRunR2Operation,
  getRunAlarmOwner,
  loadRunWorker,
  RunBindingProxy,
  type RunCacheOperation,
  type RunD1Binding,
  type RunD1Operation,
  type RunOperation,
  type RunQueueBody,
  type RunR2Binding,
  type RunR2Operation,
  runEnded,
  runObjectName,
  runQueueMessage,
  setRunAlarm,
} from "bun-test-cloudflare/workerd";

type Env = {
  DB: D1Database;
  REFERENCE: D1Database;
  BUCKET: R2Bucket;
  NATIVE_BUCKET: R2Bucket;
  LOADER: WorkerLoader;
  OBSERVED: KVNamespace;
  SLOTS: DurableObjectNamespace<Slot>;
  ALARMS: DurableObjectNamespace<Alarm>;
  QUEUE: Queue<RunQueueBody<{ slot: string }>>;
};

// The fixture's Workers are loaded per run, so their capability holds its run, as a slot's
// supervisor gives RunBindingCapability each call's.
export class FixtureCapability extends WorkerEntrypoint<unknown, { runId: string; proxy: DurableObjectStub<Slot> }> {
  invoke(name: string, ...args: unknown[]) {
    return this.ctx.props.proxy.invoke(this.ctx.props.runId, { name, args });
  }
}

export class Observer extends WorkerEntrypoint<Env> {
  record(key: string, value: string) {
    return this.env.OBSERVED.put(key, value);
  }
}

export class Slot extends RunBindingProxy<Env> {
  protected async resetBindings() {
    await this.env.DB.prepare("DELETE FROM effects WHERE slot = ?").bind(this.ctx.id.name).run();
  }

  protected async perform({ name, args }: RunOperation, runId: string) {
    if (name === "held-effect") {
      await this.env.OBSERVED.put("admitted", "true");
      while ((await this.env.OBSERVED.get("release")) === null) {
        await scheduler.wait(20);
      }
      name = "effect";
    }
    if (name === "d1") return executeRunD1Operation(this.env.DB, args[0] as RunD1Operation);
    if (name === "r2") return executeRunR2Operation(this.env.BUCKET, args[0] as RunR2Operation);
    if (name === "cache") return executeRunCacheOperation(caches, runId, args[0] as RunCacheOperation);
    const slot = this.ctx.id.name!;
    if (name === "effect") {
      await this.env.DB.prepare("INSERT INTO effects VALUES (?, ?, ?)").bind(slot, runId, args[0]).run();
    } else if (name === "queue") {
      await this.env.QUEUE.send(runQueueMessage(runId, { slot }), {
        contentType: "v8",
        delaySeconds: Number(args[0]),
      });
    } else if (name === "alarm") {
      await this.env.ALARMS.getByName(runObjectName(runId, slot)).schedule(runId, slot, Number(args[0]));
    } else {
      throw new Error("Unknown binding operation");
    }
  }
}

export class Alarm extends DurableObject<Env> {
  async schedule(runId: string, slot: string, delay: number) {
    await this.ctx.storage.put("slot", slot);
    await setRunAlarm(this.ctx.storage, runId, Date.now() + delay);
  }

  async alarm() {
    const [runId, slot] = await Promise.all([getRunAlarmOwner(this.ctx.storage), this.ctx.storage.get<string>("slot")]);
    if (!runId || !slot) throw new Error("Missing alarm owner");
    try {
      await this.env.SLOTS.getByName(slot).invoke(runId, { name: "effect", args: ["alarm"] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(runEnded)) throw error;
      await this.env.OBSERVED.put(`${runId}/alarm`, "rejected");
    }
  }
}

// Wrangler's keepNames transform inserts this helper into both functions below.
const child = `
const __name = (value, name) => Object.defineProperty(value, "name", { value: name, configurable: true });
${createRunD1Binding.toString()}
${exerciseD1.toString()}
${createRunR2Binding.toString()}
${exerciseR2.toString()}
${createRunCacheStorage.toString()}
${exerciseCache.toString()}
let requests = 0;
export default {
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname.startsWith("/d1/")) {
      const database = createRunD1Binding((operation) => env.BINDINGS.invoke("d1", operation));
      return Response.json(await exerciseD1(database));
    }
    if (new URL(request.url).pathname.startsWith("/r2/")) {
      const bucket = createRunR2Binding((operation) => env.BINDINGS.invoke("r2", operation));
      return Response.json(await exerciseR2(bucket));
    }
    if (new URL(request.url).pathname.startsWith("/cache/")) {
      const storage = createRunCacheStorage((operation) => env.BINDINGS.invoke("cache", operation));
      if (request.method === "HEAD") {
        const cached = await storage.default.match("https://cdn.example/asset");
        return new Response(null, { status: cached ? 200 : 404 });
      }
      return Response.json(await exerciseCache(storage));
    }
    const { delay } = await request.json();
    if (delay !== null) {
      await env.BINDINGS.invoke("queue", delay ? 2 : 0);
      await env.BINDINGS.invoke("alarm", delay ? 1800 : 0);
      if (delay) {
        ctx.waitUntil(
          (async () => {
            await scheduler.wait(500);
            try {
              await env.BINDINGS.invoke("effect", "childWaitUntil");
            } catch (error) {
              if (error instanceof Error && error.message.includes(${JSON.stringify(runEnded)})) {
                await env.OBSERVER.record("old/childWaitUntil", "rejected");
              }
            }
          })(),
        );
      } else {
        ctx.waitUntil(env.BINDINGS.invoke("effect", "waitUntil"));
      }
    }
    return Response.json(++requests);
  },
};
`;

async function exerciseD1(database: RunD1Binding) {
  await database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, value BLOB)");
  const insert = database.prepare("INSERT INTO items VALUES (?, ?)");
  const select = database.prepare("SELECT id, hex(value) AS bytes FROM items WHERE id >= ? ORDER BY id");
  const firstWrite = await insert.bind(1, Uint8Array.of(0, 255).buffer).run();
  const batch = await database.batch([insert.bind(2, Uint8Array.of(99).buffer), select.bind(1)]);
  let rolledBack: boolean;
  try {
    await database.batch([insert.bind(3, Uint8Array.of(1).buffer), insert.bind(2, Uint8Array.of(2).buffer)]);
    rolledBack = false;
  } catch {
    rolledBack = true;
  }
  return {
    changes: firstWrite.meta.changes,
    batch: batch.map(({ success, results, meta }) => ({ success, results, changes: meta.changes })),
    rolledBack,
    row: await select.bind(1).first(),
    column: await select.bind(2).first("bytes"),
    missing: await select.bind(5).first("bytes"),
    raw: await select.bind(1).raw({ columnNames: true }),
    all: (await select.bind(1).all()).results,
  };
}

async function exerciseR2(bucket: RunR2Binding) {
  const payload = new Blob([Uint8Array.of(0, 42, 127, 255)]);
  await bucket.put("folder/asset", payload, {
    httpMetadata: new Headers({ "content-type": "application/octet-stream", "cache-control": "max-age=45" }),
    customMetadata: { source: "fixture" },
  });
  const head = (await bucket.head("folder/asset"))!;
  const headers = new Headers();
  head.writeHttpMetadata(headers);
  const ranged = (await bucket.get("folder/asset", { range: new Headers({ range: "bytes=1-2" }) }))!;
  const denied = (await bucket.get("folder/asset", { onlyIf: new Headers({ "if-match": '"different"' }) }))!;
  const listed = await bucket.list({ prefix: "folder/" });
  await bucket.delete("folder/asset");
  const fixed = new FixedLengthStream(3);
  const writer = fixed.writable.getWriter();
  void writer.write(Uint8Array.of(7, 8, 9)).then(() => writer.close());
  await bucket.put("folder/streamed", fixed.readable);
  const streamedBytes = [...new Uint8Array(await (await bucket.get("folder/streamed"))!.arrayBuffer())];
  await bucket.delete("folder/streamed");
  const upload = await bucket.createMultipartUpload("folder/multi", { customMetadata: { mode: "multipart" } });
  const part1 = await upload.uploadPart(1, Uint8Array.of(1, 2, 3));
  const resumed = bucket.resumeMultipartUpload("folder/multi", upload.uploadId);
  const completed = await resumed.complete([part1]);
  const multiBytes = [...new Uint8Array(await (await bucket.get("folder/multi"))!.arrayBuffer())];
  await bucket.delete("folder/multi");
  return {
    size: head.size,
    etag: head.httpEtag,
    headers: [...headers],
    custom: head.customMetadata,
    checksums: head.checksums.toJSON(),
    range: ranged.range,
    body: [...new Uint8Array(await ranged.arrayBuffer())],
    consumed: ranged.bodyUsed,
    preconditionHasBody: "body" in denied,
    listed: listed.objects.map(({ key }) => key),
    deleted: await bucket.head("folder/asset"),
    streamedBytes,
    multiSize: completed.size,
    multiCustom: completed.customMetadata,
    multiBytes,
  };
}

async function exerciseCache(storage: ReturnType<typeof createRunCacheStorage>) {
  const url = "https://cdn.example/asset";
  const missing = (await storage.default.match(url)) === undefined;
  const headers = {
    "cache-control": "public, max-age=120",
    etag: '"asset"',
    "content-type": "application/octet-stream",
  };
  await storage.default.put(url, new Response(Uint8Array.of(0, 42, 127, 255), { headers }));
  const conditional = await storage.default.match(new Request(url, { headers: { "if-none-match": '"asset"' } }));
  const ranged = await storage.default.match(new Request(url, { headers: { range: "bytes=1-2" } }));
  const named = await storage.open("media");
  await named.put(url, new Response("named", { headers }));
  const namedHit = await (await named.match(url))?.text();
  const deleted = await named.delete(url);
  return {
    missing,
    conditional: conditional?.status,
    range: ranged?.status,
    contentRange: ranged?.headers.get("content-range"),
    bytes: [...new Uint8Array(await ranged!.arrayBuffer())],
    namedHit,
    deleted,
    defaultSurvived: (await (await storage.default.match(url))?.arrayBuffer())?.byteLength,
  };
}

export default {
  async fetch(request, env, ctx) {
    const [, action, slot, runId] = new URL(request.url).pathname.split("/");
    if (action === "native-d1") return Response.json(await exerciseD1(env.REFERENCE));
    if (action === "native-r2") return Response.json(await exerciseR2(env.NATIVE_BUCKET));
    if (action === "native-cache") return Response.json(await exerciseCache(caches));
    const proxy = env.SLOTS.getByName(slot);
    if (action === "activate") {
      await proxy.activate(runId);
      return new Response(null, { status: 204 });
    }
    if (!(await proxy.isActive(runId))) return new Response(null, { status: 410 });
    const capability = ctx.exports.FixtureCapability({ props: { runId, proxy } });
    if (action === "hold-write") {
      await capability.invoke("held-effect", "held");
      return new Response(null, { status: 204 });
    }
    if (action === "hold") {
      ctx.waitUntil(
        (async () => {
          // Hold native background work until the test confirms that the slot has been reassigned.
          while ((await env.OBSERVED.get("rotated")) === null) {
            await scheduler.wait(20);
          }
          try {
            await capability.invoke("effect", "waitUntil");
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes(runEnded)) throw error;
            await env.OBSERVED.put(`${runId}/waitUntil`, "rejected");
          }
        })(),
      );
      return new Response(null, { status: 204 });
    }
    return loadRunWorker(env.LOADER, runId, "fixture", () => ({
      compatibilityDate: "2026-09-09",
      mainModule: "worker.js",
      modules: { "worker.js": child },
      globalOutbound: null,
      env: {
        BINDINGS: capability,
        OBSERVER: ctx.exports.Observer({ props: {} }),
      },
    }))
      .getEntrypoint()
      .fetch(request);
  },

  async queue(batch, env) {
    const slots = new Map(batch.messages.map(({ body }) => [body.runId, body.body.slot]));
    await dispatchRunQueue(
      batch,
      async (runId) => {
        const active = await env.SLOTS.getByName(slots.get(runId)!).isActive(runId);
        if (!active) await env.OBSERVED.put(`${runId}/queue`, "rejected");
        return active;
      },
      async (runId, { messages }) => {
        for (const message of messages) {
          await env.SLOTS.getByName(message.body.slot).invoke(runId, { name: "effect", args: ["queue"] });
        }
      },
    );
  },
} satisfies ExportedHandler<Env, RunQueueBody<{ slot: string }>>;
