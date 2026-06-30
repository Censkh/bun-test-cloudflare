import { DurableObject } from "cloudflare:workers";

type Env = {
  COUNTER: DurableObjectNamespace<Counter>;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  IMAGES: ImagesBinding;
  JOB_QUEUE: Queue;
  KV: KVNamespace;
  OTHER: Fetcher;
};

export class Counter extends DurableObject {
  async increment() {
    const current = (await this.ctx.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}

const parseMetadata = async (request: Request) => {
  const form = await request.formData();
  return {
    name: form.get("name"),
    score: Number(form.get("metadata.0.value")),
    published: form.get("metadata.1.value") === "true",
  };
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/other") {
      return env.OTHER.fetch("https://other.local/");
    }
    if (url.pathname === "/image-info") {
      const bytes = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
      const stream = new Response(bytes).body;
      if (!stream) throw new Error("missing stream");
      return Response.json(await env.IMAGES.info(stream));
    }
    if (url.pathname === "/asset" && request.method === "POST") {
      const metadata = await parseMetadata(request);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO items (id, value) VALUES (?, ?)").bind(id, String(metadata.name ?? "asset")).run();
      await env.DOCUMENTS.put(id, JSON.stringify(metadata));
      await env.KV.put(id, String(metadata.name ?? "asset"));
      ctx.waitUntil((async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await env.JOB_QUEUE.send({ id, metadata });
        await env.DB.prepare("UPDATE items SET value = ? WHERE id = ?").bind("waitUntil", id).run();
      })());
      const stub = env.COUNTER.get(env.COUNTER.idFromName("fixture"));
      const count = await stub.increment();
      return Response.json({ id, count, metadata });
    }
    if (url.pathname === "/count") {
      const row = await env.DB.prepare("SELECT COUNT(*) AS count FROM items").first<{ count: number }>();
      return Response.json({ count: row?.count ?? 0 });
    }
    return Response.json({ ok: true, path: url.pathname });
  },
};
