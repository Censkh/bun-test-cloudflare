type Env = {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  KV: KVNamespace;
  OTHER: Fetcher;
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
    const id = url.searchParams.get("id") ?? crypto.randomUUID();
    await env.DB.prepare("INSERT OR REPLACE INTO items (id, value) VALUES (?, ?)").bind(id, url.pathname).run();
    await env.KV.put(id, url.pathname);
    await env.DOCUMENTS.put(id, url.pathname);
    ctx.waitUntil(env.OTHER.fetch("https://other.local/"));
    return Response.json({ id, ok: true });
  },
};
