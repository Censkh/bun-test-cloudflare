import { AsyncLocalStorage } from "node:async_hooks";
import type { CapturedDevEnv } from "./wranglerPatches";

type RuntimeMiniflare = {
  getCaches(): Promise<CacheStorage>;
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

const cacheStorageProxy = new Proxy({} as CacheStorage, {
  get(_target, property) {
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
