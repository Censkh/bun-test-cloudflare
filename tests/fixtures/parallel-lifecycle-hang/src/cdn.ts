export default {
  async fetch(request: Request, env: { DB: D1Database; DOCUMENTS: R2Bucket; KV: KVNamespace }) {
    const key = new URL(request.url).searchParams.get("key") ?? crypto.randomUUID();
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS cdn_items (id TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    await env.DB.prepare("INSERT OR REPLACE INTO cdn_items (id, value) VALUES (?, ?)").bind(key, "cdn").run();
    await env.KV.put(key, "cdn");
    await env.DOCUMENTS.put(key, "cdn");
    return Response.json({ key, ok: true });
  },
};
