const cacheKey = (request: Request) => {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) throw new Error("Missing key");
  return new Request(key);
};

export default {
  async fetch(request: Request) {
    const url = new URL(request.url);

    if (url.pathname === "/cache/match") {
      const response = await caches.default.match(cacheKey(request));
      return response ?? new Response("missing", { status: 404 });
    }

    if (url.pathname === "/cache/put") {
      const value = url.searchParams.get("value") ?? "";
      await caches.default.put(cacheKey(request), new Response(value, { headers: { "Cache-Control": "max-age=60" } }));
      return new Response("stored");
    }

    return new Response("ok");
  },
};
