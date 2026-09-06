import { AsyncLocalStorage } from "node:async_hooks";
import { shouldInstallCompatibilityPatch } from "./CompatibilityPatches";
import type { CapturedDevEnv } from "./wranglerPatches";

type RuntimeMiniflare = {
  getCaches(): Promise<CacheStorage>;
};

type CloudflareCacheStorage = CacheStorage & {
  default: Cache;
};

type CacheBridgeWorker = {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
};

type SerializedCacheRequest = {
  headers: Array<[string, string]>;
  method: string;
  url: string;
};

type SerializedCacheResponse = {
  headers: Array<[string, string]>;
  status: number;
  statusText: string;
};

type CacheBridgeMetadata = {
  cacheName?: string;
  operation: "delete" | "match" | "put";
  options?: CacheQueryOptions;
  request: SerializedCacheRequest;
  response?: SerializedCacheResponse;
};

type CacheBridgePayload = {
  bodyBase64?: string;
  metadata: CacheBridgeMetadata;
};

type CacheBridgeResult<T> = {
  bodyBase64?: string;
  metadata: T;
};

export const WORKER_CACHE_BRIDGE_PATH = "/__bun-test-cloudflare/cache";
export const WORKER_CACHE_BRIDGE_SECRET_HEADER = "x-bun-test-cloudflare-cache-secret";

type CapturedDevEnvWithRuntime = CapturedDevEnv & {
  runtimes?: Array<{ mf?: RuntimeMiniflare }>;
};

declare global {
  var __bunTestCloudflareCachesBridgeInstalled: boolean | undefined;
}

const cacheStorageContext = new AsyncLocalStorage<CacheStorage>();

const getActiveCacheStorage = () => {
  const cacheStorage = cacheStorageContext.getStore();
  if (!cacheStorage) {
    throw new Error("Cloudflare Cache API is only available inside cloudflareHarness.run()");
  }
  return cacheStorage;
};

const createCacheProxy = (getCache: (cacheStorage: CacheStorage) => Cache | Promise<Cache>) =>
  new Proxy({} as Cache, {
    get(_target, property) {
      return (...args: unknown[]) => {
        const cache = getCache(getActiveCacheStorage());
        if (cache instanceof Promise) {
          return cache.then((resolvedCache) => {
            const value = resolvedCache[property as keyof Cache];
            return typeof value === "function"
              ? Reflect.apply(value as (...args: unknown[]) => unknown, resolvedCache, args)
              : value;
          });
        }

        const value = cache[property as keyof Cache];
        return typeof value === "function"
          ? Reflect.apply(value as (...args: unknown[]) => unknown, cache, args)
          : value;
      };
    },
  });

const defaultCacheProxy = createCacheProxy((cacheStorage) => (cacheStorage as CloudflareCacheStorage).default);
const namedCacheProxies = new Map<string, Cache>();

const getNamedCacheProxy = (cacheName: string) => {
  const existingProxy = namedCacheProxies.get(cacheName);
  if (existingProxy) {
    return existingProxy;
  }

  const cacheProxy = createCacheProxy((cacheStorage) => cacheStorage.open(cacheName));
  namedCacheProxies.set(cacheName, cacheProxy);
  return cacheProxy;
};

const cacheStorageProxy = new Proxy({} as CacheStorage, {
  get(_target, property) {
    if (property === "default") {
      if (!shouldInstallCompatibilityPatch("global-caches-default")) {
        return undefined;
      }
      return defaultCacheProxy;
    }

    if (property === "open") {
      if (!shouldInstallCompatibilityPatch("global-caches-named")) {
        return undefined;
      }
      return async (cacheName: string) => getNamedCacheProxy(cacheName);
    }

    const value = getActiveCacheStorage()[property as keyof CacheStorage];
    return typeof value === "function" ? value.bind(getActiveCacheStorage()) : value;
  },
});

export const installGlobalCachesBridge = () => {
  if (!shouldInstallCompatibilityPatch("global-caches-install")) {
    return;
  }
  if (globalThis.__bunTestCloudflareCachesBridgeInstalled) {
    return;
  }

  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    get: () => cacheStorageProxy,
  });
  globalThis.__bunTestCloudflareCachesBridgeInstalled = true;
};

export const runWithCloudflareCaches = <TResult>(
  cacheStorage: CacheStorage,
  callback: () => Promise<TResult> | TResult,
) => cacheStorageContext.run(cacheStorage, callback);

export const getCapturedRuntimeCaches = async (devEnvs: CapturedDevEnv[]) => {
  for (const devEnv of devEnvs as CapturedDevEnvWithRuntime[]) {
    const miniflare = devEnv.runtimes?.[0]?.mf;
    if (miniflare) {
      return await miniflare.getCaches();
    }
  }
};

const serializeCacheRequest = (input: RequestInfo | URL): SerializedCacheRequest => {
  const request = input instanceof Request ? input : new Request(input);
  return {
    headers: [...request.headers],
    method: request.method,
    url: request.url,
  };
};

const arrayBufferToBase64 = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64");

const base64ToArrayBuffer = (base64: string) => {
  const buffer = Buffer.from(base64, "base64");
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
};

const createCacheBridgePayload = async (metadata: CacheBridgeMetadata, body?: Blob): Promise<CacheBridgePayload> => {
  return {
    metadata,
    bodyBase64: body ? arrayBufferToBase64(await body.arrayBuffer()) : undefined,
  };
};

const readCacheBridgeMetadata = async <T>(response: Response) => {
  if (!response.ok) {
    throw new Error(`Worker cache bridge failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as CacheBridgeResult<T>;
};

export const createWorkerCacheStorage = (worker: CacheBridgeWorker, secret: string): CacheStorage => {
  const requestBridge = (payload: CacheBridgePayload | Promise<CacheBridgePayload>) =>
    Promise.resolve(payload).then((resolvedPayload) =>
      worker.fetch(`https://bun-test-cloudflare.invalid${WORKER_CACHE_BRIDGE_PATH}`, {
        body: JSON.stringify(resolvedPayload),
        headers: {
          "Content-Type": "application/json",
          [WORKER_CACHE_BRIDGE_SECRET_HEADER]: secret,
        },
        method: "POST",
      }),
    );

  const createCache = (cacheName?: string) =>
    ({
      async delete(input: RequestInfo | URL, options?: CacheQueryOptions) {
        const response = await requestBridge(
          createCacheBridgePayload({ cacheName, operation: "delete", options, request: serializeCacheRequest(input) }),
        );
        const result = await readCacheBridgeMetadata<{ deleted: boolean }>(response);
        return result.metadata.deleted;
      },
      async match(input: RequestInfo | URL, options?: CacheQueryOptions) {
        const response = await requestBridge(
          createCacheBridgePayload({ cacheName, operation: "match", options, request: serializeCacheRequest(input) }),
        );
        const result = await readCacheBridgeMetadata<{ response?: SerializedCacheResponse }>(response);
        if (!result.metadata.response) {
          return undefined;
        }
        const body = result.bodyBase64 ? base64ToArrayBuffer(result.bodyBase64) : null;
        return new Response(body, result.metadata.response);
      },
      async put(input: RequestInfo | URL, response: Response) {
        const responseBody = await response.blob();
        const bridgeResponse = await requestBridge(
          createCacheBridgePayload(
            {
              cacheName,
              operation: "put",
              request: serializeCacheRequest(input),
              response: {
                headers: [...response.headers],
                status: response.status,
                statusText: response.statusText,
              },
            },
            responseBody,
          ),
        );
        await readCacheBridgeMetadata(bridgeResponse);
      },
    }) as unknown as Cache;

  return {
    default: createCache(),
    open: async (cacheName: string) => createCache(cacheName),
  } as CloudflareCacheStorage;
};
