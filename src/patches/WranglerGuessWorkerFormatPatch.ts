import { mock } from "bun:test";
import { createRequire } from "node:module";

type BuildOptions = {
  absWorkingDir?: string;
  bundle?: boolean;
  entryPoints?: string[];
  logLevel?: string;
  metafile?: boolean;
  tsconfig?: string;
  write?: boolean;
};

type BuildResult = unknown;

type EsbuildModule = {
  build(options: BuildOptions): Promise<BuildResult>;
  stop?: () => void;
  [key: PropertyKey]: unknown;
};

declare global {
  var __bunTestCloudflareGuessWorkerFormatBuildCache: Map<string, Promise<BuildResult>> | undefined;
  var __bunTestCloudflareGuessWorkerFormatPatched: boolean | undefined;
}

const localRequire = require;
const requireFromWrangler = createRequire(localRequire.resolve("wrangler"));

const getSingleEntryPoint = (options: BuildOptions) => {
  const [entryPoint] = options.entryPoints ?? [];
  return typeof entryPoint === "string" && options.entryPoints?.length === 1 ? entryPoint : undefined;
};

const isWranglerGuessWorkerFormatBuild = (options: BuildOptions) =>
  options.metafile === true &&
  options.bundle === false &&
  options.write === false &&
  options.logLevel === "silent" &&
  typeof options.absWorkingDir === "string" &&
  getSingleEntryPoint(options) !== undefined;

const getCacheKey = (options: BuildOptions) =>
  [
    options.absWorkingDir,
    getSingleEntryPoint(options),
    typeof options.tsconfig === "string" ? options.tsconfig : "",
  ].join("\0");

const isStoppedServiceError = (error: unknown) =>
  error instanceof Error && /^The service (is no longer running|was stopped)/.test(error.message);

const STALLED_PROBE_TIMEOUT_MS = 10_000;
const MAX_SERVICE_RESTARTS = 2;

class StalledServiceError extends Error {
  constructor(timeoutMs: number) {
    super(`esbuild's service did not answer within ${timeoutMs}ms`);
  }
}

const failIfStalled = async <TResult>(call: Promise<TResult>, timeoutMs: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      call,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new StalledServiceError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * esbuild never replaces a dead service. Bun kills it with every other child process when a test
 * times out, after which calls fail with "The service is no longer running" or, because a killed
 * service doesn't always close its streams, never settle. stop() forgets the service and fails the
 * calls still waiting on it, so the next call starts a new one. Calls that fail together restart it
 * once: a second stop() would kill the replacement the first retry is using.
 */
export const createEsbuildServiceRestarter = (esbuild: Pick<EsbuildModule, "stop">) => {
  let service = 0;
  return async <TResult>(call: () => Promise<TResult>): Promise<TResult> => {
    for (let restarts = 0; ; restarts++) {
      const calledService = service;
      try {
        return await call();
      } catch (error) {
        const stopped = error instanceof StalledServiceError || isStoppedServiceError(error);
        if (!stopped || restarts === MAX_SERVICE_RESTARTS) throw error;
        if (calledService === service) {
          service += 1;
          await esbuild.stop?.();
        }
      }
    }
  };
};

type EsbuildPatchOptions = {
  cacheGuessWorkerFormat: boolean;
  restartStoppedService: boolean;
  stalledProbeTimeoutMs?: number;
};

const restartedServiceCalls = ["build", "context", "transform", "formatMessages", "analyzeMetafile"] as const;

export const createPatchedEsbuild = (esbuild: EsbuildModule, options: EsbuildPatchOptions): EsbuildModule => {
  const overrides = new Map<PropertyKey, unknown>();
  const stalledProbeTimeoutMs = options.stalledProbeTimeoutMs ?? STALLED_PROBE_TIMEOUT_MS;
  if (options.restartStoppedService) {
    const withRestartedService = createEsbuildServiceRestarter(esbuild);
    for (const key of restartedServiceCalls) {
      const call = esbuild[key] as ((...args: unknown[]) => Promise<unknown>) | undefined;
      if (typeof call !== "function") continue;
      overrides.set(key, (...args: unknown[]) =>
        withRestartedService(() => {
          // A format probe takes milliseconds, so one with no answer is talking to a lost service.
          // Real builds have no such bound.
          const isProbe = key === "build" && isWranglerGuessWorkerFormatBuild(args[0] as BuildOptions);
          return isProbe ? failIfStalled(call(...args), stalledProbeTimeoutMs) : call(...args);
        }),
      );
    }
  }
  const originalBuild = (overrides.get("build") ?? esbuild.build) as EsbuildModule["build"];

  if (options.cacheGuessWorkerFormat) {
    overrides.set("build", (buildOptions: BuildOptions) => {
      if (!isWranglerGuessWorkerFormatBuild(buildOptions)) {
        return originalBuild(buildOptions);
      }

      // Wrangler's test harness re-runs guessWorkerFormat() on every server
      // session, even when we already compiled the worker with dry-run output.
      // Under load a request to esbuild's service can go unanswered, which stalled
      // whole workerd generation resets, so only the first probe of a worker asks it.
      const cache = (globalThis.__bunTestCloudflareGuessWorkerFormatBuildCache ??= new Map());
      const cacheKey = getCacheKey(buildOptions);
      const cachedBuild = cache.get(cacheKey);
      if (cachedBuild) {
        return cachedBuild;
      }

      const build = originalBuild(buildOptions).catch((error) => {
        cache.delete(cacheKey);
        throw error;
      });
      cache.set(cacheKey, build);
      return build;
    });
  }

  const patchedEsbuild: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(esbuild)) {
    const descriptor = Object.getOwnPropertyDescriptor(esbuild, key);
    Object.defineProperty(patchedEsbuild, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => (overrides.has(key) ? overrides.get(key) : esbuild[key]),
    });
  }

  return patchedEsbuild as EsbuildModule;
};

export const installWranglerEsbuildPatch = (options: EsbuildPatchOptions) => {
  if (process.env.BUN_TEST_CLOUDFLARE_DISABLE_GUESS_WORKER_FORMAT_PATCH) {
    options = { ...options, cacheGuessWorkerFormat: false };
  }
  if (globalThis.__bunTestCloudflareGuessWorkerFormatPatched) {
    return;
  }
  if (!options.cacheGuessWorkerFormat && !options.restartStoppedService) {
    return;
  }

  const esbuild = requireFromWrangler("esbuild") as EsbuildModule;
  const patchedEsbuild = createPatchedEsbuild(esbuild, options);
  mock.module("esbuild", () => patchedEsbuild);
  globalThis.__bunTestCloudflareGuessWorkerFormatPatched = true;
};

export const stopWranglerEsbuildService = () => {
  const esbuild = requireFromWrangler("esbuild") as EsbuildModule;
  esbuild.stop?.();
  globalThis.__bunTestCloudflareGuessWorkerFormatBuildCache?.clear();
};
