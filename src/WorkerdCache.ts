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
) {
  // A named cache preserves the original URL, method and headers while isolating the keys.
  const cache = await storage.open(JSON.stringify([runId, cacheName]));
  const { request } = operation;
  switch (operation.method) {
    case "delete":
      return cache.delete(request, operation.options);
    case "match":
      return cache.match(request, operation.options);
    case "put":
      return cache.put(request, operation.response);
  }
}
