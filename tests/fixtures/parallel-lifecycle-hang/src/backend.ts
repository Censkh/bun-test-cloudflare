import { DurableObject } from "cloudflare:workers";

type Env = {
  CDN: Fetcher;
  COUNTER: DurableObjectNamespace<Counter>;
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  IMAGES: ImagesBinding;
  JOB_QUEUE: Queue;
  KV: KVNamespace;
};

export class Counter extends DurableObject {
  async increment() {
    const current = (await this.ctx.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}

const pngBytes = () => Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    const id = url.searchParams.get("id") ?? crypto.randomUUID();

    if (url.pathname === "/multipart") {
      const formData = await request.formData();
      const value = String(formData.get("value") ?? "multipart");
      await env.DB.prepare("INSERT OR REPLACE INTO items (id, value) VALUES (?, ?)").bind(id, value).run();
      await env.DOCUMENTS.put(id, value);
      await env.KV.put(id, value);
      ctx.waitUntil(env.JOB_QUEUE.send({ id, value }));
      return Response.json({ id, value });
    }

    if (url.pathname === "/image-info") {
      const stream = new Response(pngBytes()).body;
      if (!stream) throw new Error("missing image stream");
      return Response.json(await env.IMAGES.info(stream));
    }

    if (url.pathname === "/cdn") {
      const response = await env.CDN.fetch(`https://cdn.local/?key=${id}`);
      return Response.json(await response.json());
    }

    if (url.pathname === "/count") {
      const stub = env.COUNTER.get(env.COUNTER.idFromName("fixture"));
      return Response.json({ count: await stub.increment() });
    }

    return Response.json({ ok: true });
  },
};
