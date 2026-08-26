let requestCount = 0;

export default {
  async fetch(request: Request) {
    requestCount += 1;
    const cacheKey = new Request("https://prewarmed-storage-reset.invalid/worker-cache");
    if (new URL(request.url).pathname === "/write-cache") {
      await caches.default.put(
        cacheKey,
        new Response("present", { headers: { "Cache-Control": "public, max-age=60" } }),
      );
    }
    const cached = await caches.default.match(cacheKey);
    return Response.json({ cached: cached ? await cached.text() : null, requestCount });
  },
};
