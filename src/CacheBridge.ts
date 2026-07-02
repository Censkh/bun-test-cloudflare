import { AsyncLocalStorage } from "node:async_hooks";
import type { CapturedDevEnv } from "./wranglerPatches";

type RuntimeMiniflare = {
  getCaches(): Promise<CacheStorage>;
};

type CloudflareCacheStorage = CacheStorage & {
  default: Cache;
};

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
      return defaultCacheProxy;
    }

    if (property === "open") {
      return async (cacheName: string) => getNamedCacheProxy(cacheName);
    }

    const value = getActiveCacheStorage()[property as keyof CacheStorage];
    return typeof value === "function" ? value.bind(getActiveCacheStorage()) : value;
  },
});

export const installGlobalCachesBridge = () => {
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
