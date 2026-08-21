import { AsyncLocalStorage } from "node:async_hooks";
import { shouldInstallCompatibilityPatch, shouldInstallCompatibilityPatchGroup } from "./CompatibilityPatches";

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
  runtimes?: Array<{
    mf?: {
      dispose?: () => Promise<void> | void;
    };
  }>;
  on?: (event: string, listener: (value: any) => void) => unknown;
  runtimeErrors?: Array<{
    source?: string;
    stack?: string;
    text?: string;
  }>;
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
const testHarnessPersistencePathContext = new AsyncLocalStorage<string>();

export const runWithTestHarnessPersistencePath = <T>(persistencePath: string, callback: () => T) =>
  testHarnessPersistencePathContext.run(persistencePath, callback);

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
    return (
      url?.pathname === "/cdn-cgi/platform-proxy" ||
      url?.pathname.startsWith("/cdn-cgi/ProxyWorker/") ||
      url?.pathname.startsWith("/cdn-cgi/ProxyWorker")
    );
  } catch {
    return false;
  }
};

const trackResponseBody = (response: Response, tracker: AsyncOperationTracker) => {
  if (!shouldInstallCompatibilityPatch("platform-proxy-response-drain")) {
    return response;
  }
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
        if (shouldInstallCompatibilityPatch("wrangler-dev-env-runtime-errors")) {
          this.runtimeErrors = [];
          this.on?.("runtimeError", (error: { source?: string; stack?: string; text?: string }) => {
            this.runtimeErrors?.push(error);
            console.error("[bun-test-cloudflare] Worker runtime error:", error.text ?? "Unknown error");
            if (error.stack) {
              console.error(error.stack);
            }
          });
        }
        if (
          shouldInstallCompatibilityPatch("wrangler-dev-env-force-local") ||
          shouldInstallCompatibilityPatch("wrangler-dev-env-persist")
        ) {
          this.#installConfigPatch();
        }
        if (shouldInstallCompatibilityPatch("wrangler-dev-env-capture")) {
          devEnvCaptureContext.getStore()?.push(this);
        }
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
              if (shouldInstallCompatibilityPatch("wrangler-dev-env-force-local")) {
                input.dev.remote = false;
              }

              const persistencePath = testHarnessPersistencePathContext.getStore();
              if (persistencePath && shouldInstallCompatibilityPatch("wrangler-dev-env-persist")) {
                input.dev.persist = persistencePath;
              }
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
  if (
    shouldInstallCompatibilityPatchGroup("wrangler-dev-env", [
      "wrangler-dev-env-runtime-errors",
      "wrangler-dev-env-capture",
      "wrangler-dev-env-force-local",
      "wrangler-dev-env-persist",
    ])
  ) {
    installDevEnvCapture();
  }
};

export const drainDevEnvRuntimeMessages = async (devEnvs: CapturedDevEnv[]) => {
  await Promise.all(
    devEnvs.map(async (devEnv) => {
      await devEnv.proxy?.runtimeMessageMutex?.drained?.();
    }),
  );
};

export const disposeCapturedMiniflareRuntimes = async (devEnvs: CapturedDevEnv[]) => {
  await Promise.allSettled(
    devEnvs.flatMap(
      (devEnv) =>
        devEnv.runtimes?.map(async (runtime) => {
          await runtime.mf?.dispose?.();
        }) ?? [],
    ),
  );
};
