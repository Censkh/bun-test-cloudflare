export type RunCacheOperation = { cacheName?: string; request: Request } & (
  | { method: "put"; response: Response }
  | { method: "match" | "delete"; options?: CacheQueryOptions }
);

type RunCache = Pick<Cache, "delete" | "match" | "put">;
type RunCacheStorage = { default: RunCache; open(name: string): Promise<RunCache> };

/** The supervisor owns the Cache API. Pass requests and responses through Workers RPC. */
export function createRunCacheStorage(invoke: (operation: RunCacheOperation) => Promise<unknown>): RunCacheStorage {
  const create = (cacheName?: string): RunCache => ({
    delete: (request, options) =>
      invoke({ cacheName, method: "delete", request: new Request(request), options }) as Promise<boolean>,
    match: (request, options) =>
      invoke({ cacheName, method: "match", request: new Request(request), options }) as Promise<Response | undefined>,
    async put(request, response) {
      await invoke({ cacheName, method: "put", request: new Request(request), response });
    },
  });
  return {
    default: create(),
    open: async (name) => create(name),
  };
}

export async function executeRunCacheOperation(
  storage: Pick<RunCacheStorage, "open">,
  runId: string,
  { cacheName, ...operation }: RunCacheOperation,
  onPut?: (cacheName: string | undefined, url: string) => void,
) {
  // A named cache preserves the original URL, method and headers while isolating the keys.
  const cache = await storage.open(JSON.stringify([runId, cacheName]));
  const { request } = operation;
  switch (operation.method) {
    case "delete":
      return cache.delete(request, operation.options);
    case "match":
      return cache.match(request, operation.options);
    case "put": {
      let response = operation.response;
      if (response.body !== null) {
        const bytes = await response.arrayBuffer();
        const headers = new Headers(response.headers);
        if (!headers.has("content-length")) {
          headers.set("content-length", String(bytes.byteLength));
        }
        response = new Response(bytes, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
      await cache.put(request, response);
      onPut?.(cacheName, request.url);
      return;
    }
  }
}

/** Reclaims cached entries written during a retired run. */
export async function clearRunCaches(
  storage: Pick<RunCacheStorage, "open">,
  runId: string,
  entries: Map<string | undefined, Set<string>>,
): Promise<void> {
  for (const [cacheName, urls] of entries) {
    if (urls.size === 0) continue;
    const cache = await storage.open(JSON.stringify([runId, cacheName]));
    await Promise.all(Array.from(urls, (url) => cache.delete(url, { ignoreMethod: true })));
  }
  entries.clear();
}
