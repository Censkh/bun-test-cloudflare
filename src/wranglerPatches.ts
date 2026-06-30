import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";

const runtimeTeardownGuardSymbol = Symbol("bunTestCloudflareRuntimeTeardownGuard");

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
  runtimes?: RuntimeController[];
};

type RuntimeController = {
  teardown?: () => Promise<void>;
  [runtimeTeardownGuardSymbol]?: true;
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

const runtimeTeardowns = new WeakMap<RuntimeController, Promise<void>>();

export const installRuntimeTeardownGuard = (runtime: RuntimeController) => {
  if (!runtime.teardown || runtime[runtimeTeardownGuardSymbol]) {
    return;
  }

  const originalTeardown = runtime.teardown.bind(runtime);
  runtime.teardown = () => {
    const existingTeardown = runtimeTeardowns.get(runtime);
    if (existingTeardown) {
      return existingTeardown;
    }

    const teardown = originalTeardown();
    runtimeTeardowns.set(runtime, teardown);
    return teardown;
  };
  runtime[runtimeTeardownGuardSymbol] = true;
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
        this.runtimes?.forEach(installRuntimeTeardownGuard);
        devEnvCaptureContext.getStore()?.push(this);
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
