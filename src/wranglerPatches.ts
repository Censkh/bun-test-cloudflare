import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

export type CapturedDevEnv = {
  config?: {
    latestConfig?: {
      name?: string;
    };
  };
  proxy?: {
    runtimeMessageMutex?: {
      drained?: () => Promise<void>;
    };
  };
  runtimes?: unknown[];
};

export type AsyncOperationTracker = {
  drain(): Promise<void>;
  track<T>(promise: Promise<T>): Promise<T>;
};

type WranglerModuleWithDevEnv = typeof import("wrangler") & {
  unstable_DevEnv?: new (...args: any[]) => CapturedDevEnv;
};

export const devEnvCaptureContext = new AsyncLocalStorage<CapturedDevEnv[]>();
export const platformProxyDispatchContext = new AsyncLocalStorage<AsyncOperationTracker>();

export const createAsyncOperationTracker = (): AsyncOperationTracker => {
  const pending = new Set<Promise<unknown>>();

  return {
    async drain() {
      while (pending.size > 0) {
        await Promise.allSettled([...pending]);
      }
    },
    track<T>(promise: Promise<T>) {
      const tracked = promise.finally(() => {
        pending.delete(tracked);
      });
      tracked.catch(() => {});
      pending.add(tracked);
      return promise;
    },
  };
};

const isPlatformProxyFetch = (input: unknown) => {
  try {
    const url =
      typeof input === "string"
        ? new URL(input)
        : input instanceof URL
          ? input
          : input instanceof Request
            ? new URL(input.url)
            : undefined;
    return url?.pathname === "/cdn-cgi/platform-proxy";
  } catch {
    return false;
  }
};

const trackResponseBody = (response: Response, tracker: AsyncOperationTracker) => {
  if (!response.body) {
    return response;
  }

  // Drain one branch independently so cleanup does not depend on user code
  // consuming the Response returned by a platform-proxy binding call.
  const [trackedBody, userBody] = response.body.tee();
  tracker.track(new Response(trackedBody).arrayBuffer().then(() => undefined));
  return new Response(userBody, response);
};

export const trackPlatformProxyDispatch = (input: unknown, promise: Promise<Response>) => {
  const tracker = platformProxyDispatchContext.getStore();
  if (!tracker || !isPlatformProxyFetch(input)) {
    return promise;
  }

  return tracker.track(promise.then((response) => trackResponseBody(response, tracker)));
};

const installDevEnvCapture = () => {
  const require = createRequire(import.meta.url);
  const wranglerModule = require("wrangler") as WranglerModuleWithDevEnv;
  const OriginalDevEnv = wranglerModule.unstable_DevEnv;
  if (!OriginalDevEnv) {
    return;
  }

  const descriptor = Object.getOwnPropertyDescriptor(wranglerModule, "unstable_DevEnv");
  if (descriptor && !descriptor.writable && !descriptor.set) {
    return;
  }

  try {
    wranglerModule.unstable_DevEnv = class BunTestCloudflareCapturedDevEnv extends OriginalDevEnv {
      constructor(...args: any[]) {
        super(...args);
        this.#installConfigPatch();
        devEnvCaptureContext.getStore()?.push(this);
      }

      #installConfigPatch() {
        const config = this.config;
        if (config?.set && !(config.set as any).__bunTestCloudflareTraced) {
          const originalSet = config.set.bind(config);
          config.set = (async (...setArgs: any[]) => {
            const input = setArgs[0];
            if (input && typeof input === "object" && input.dev && typeof input.dev === "object") {
              // Wrangler's createTestHarness() does not set `dev.remote`.
              // Undefined enables remote binding proxy setup for bindings that
              // cannot be simulated locally (for example Flagship). These tests
              // run against Miniflare-local bindings, so force local mode before
              // ConfigController resolves the worker bindings.
              input.dev.remote = false;
            }
            return (originalSet as (...args: any[]) => Promise<unknown>)(...setArgs);
          }) as typeof config.set;
          Object.defineProperty(config.set, "__bunTestCloudflareTraced", { value: true });
        }
      }
    };
  } catch {}
};

export const installWranglerPatches = () => {
  installDevEnvCapture();
};

export const drainDevEnvRuntimeMessages = async (devEnvs: CapturedDevEnv[]) => {
  await Promise.all(
    devEnvs.map(async (devEnv) => {
      await devEnv.proxy?.runtimeMessageMutex?.drained?.();
    }),
  );
};
