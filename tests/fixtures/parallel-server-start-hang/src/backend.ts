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

type MultipartState = {
  parts: R2UploadedPart[];
  storageId: string;
  uploadId: string;
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

const readMultipartBlob = async (request: Request) => {
  const form = await request.formData();
  const blob = form.get("part.blob") ?? form.get("blob") ?? [...form.values()].find((value) => value instanceof Blob);
  if (!(blob instanceof Blob)) {
    throw new Error(`missing multipart blob: ${[...form.keys()].join(",")}`);
  }
  return Buffer.from(await blob.arrayBuffer());
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/other") {
      return env.OTHER.fetch("https://other.local/");
    }
    if (url.pathname === "/image-info") {
      const bytes = Uint8Array.from(
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
          "base64",
        ),
      );
      const stream = new Response(bytes).body;
      if (!stream) throw new Error("missing stream");
      return Response.json(await env.IMAGES.info(stream));
    }
    if (url.pathname === "/multipart/start" && request.method === "POST") {
      const id = crypto.randomUUID();
      const storageId = `uploads/${id}`;
      const stateKey = `multipart/${id}`;
      const upload = await env.DOCUMENTS.createMultipartUpload(storageId, {
        httpMetadata: { contentType: "image/png" },
      });
      const part = await upload.uploadPart(1, await readMultipartBlob(request));
      const state: MultipartState = { parts: [part], storageId, uploadId: upload.uploadId };
      await env.DOCUMENTS.put(stateKey, JSON.stringify(state));
      return Response.json({ id, receivedParts: 1 });
    }
    if (url.pathname === "/multipart/complete" && request.method === "POST") {
      const id = url.searchParams.get("id");
      if (!id) return new Response("missing id", { status: 400 });
      const stateKey = `multipart/${id}`;
      const stateObject = await env.DOCUMENTS.get(stateKey);
      if (!stateObject) return new Response("missing state", { status: 404 });

      const state = (await stateObject.json()) as MultipartState;
      const upload = env.DOCUMENTS.resumeMultipartUpload(state.storageId, state.uploadId);
      const part = await upload.uploadPart(2, await readMultipartBlob(request));
      await upload.complete([...state.parts, part]);
      const object = await env.DOCUMENTS.get(state.storageId);
      if (!object) return new Response("missing object", { status: 500 });
      const bytes = await object.arrayBuffer();
      await env.DOCUMENTS.delete(stateKey);
      await env.DOCUMENTS.delete(state.storageId);
      return Response.json({ bytes: bytes.byteLength, receivedParts: 2 });
    }
    if (url.pathname === "/asset" && request.method === "POST") {
      const metadata = await parseMetadata(request);
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO items (id, value) VALUES (?, ?)")
        .bind(id, String(metadata.name ?? "asset"))
        .run();
      await env.DOCUMENTS.put(id, JSON.stringify(metadata));
      await env.KV.put(id, String(metadata.name ?? "asset"));
      ctx.waitUntil(
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 150));
          await env.JOB_QUEUE.send({ id, metadata });
          await env.DB.prepare("UPDATE items SET value = ? WHERE id = ?").bind("waitUntil", id).run();
        })(),
      );
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
