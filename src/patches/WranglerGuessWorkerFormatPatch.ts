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
  [key: PropertyKey]: unknown;
};

declare global {
  var __bunTestCloudflareGuessWorkerFormatBuildCache: Map<string, Promise<BuildResult>> | undefined;
  var __bunTestCloudflareGuessWorkerFormatPatched: boolean | undefined;
}

const localRequire = createRequire(import.meta.url);
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

const createPatchedEsbuild = (esbuild: EsbuildModule): EsbuildModule => {
  const originalBuild = esbuild.build.bind(esbuild);
  const patchedBuild = (options: BuildOptions) => {
    if (!isWranglerGuessWorkerFormatBuild(options)) {
      return originalBuild(options);
    }

    // Wrangler's test harness re-runs guessWorkerFormat() on every server
    // session, even when we already compiled the worker with dry-run output.
    // If a Bun test times out, the shared esbuild service can be left stopped;
    // memoising this metadata-only probe avoids a second esbuild call for the
    // same already-built worker while preserving Wrangler's first result.
    const cache = (globalThis.__bunTestCloudflareGuessWorkerFormatBuildCache ??= new Map());
    const cacheKey = getCacheKey(options);
    const cachedBuild = cache.get(cacheKey);
    if (cachedBuild) {
      return cachedBuild;
    }

    const build = originalBuild(options).catch((error) => {
      cache.delete(cacheKey);
      throw error;
    });
    cache.set(cacheKey, build);
    return build;
  };

  const patchedEsbuild: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(esbuild)) {
    const descriptor = Object.getOwnPropertyDescriptor(esbuild, key);
    Object.defineProperty(patchedEsbuild, key, {
      configurable: true,
      enumerable: descriptor?.enumerable ?? true,
      get: () => (key === "build" ? patchedBuild : esbuild[key]),
    });
  }

  return patchedEsbuild as EsbuildModule;
};

export const installWranglerGuessWorkerFormatPatch = () => {
  if (process.env.BUN_TEST_CLOUDFLARE_DISABLE_GUESS_WORKER_FORMAT_PATCH) {
    return;
  }

  if (globalThis.__bunTestCloudflareGuessWorkerFormatPatched) {
    return;
  }

  const esbuild = requireFromWrangler("esbuild") as EsbuildModule;
  const patchedEsbuild = createPatchedEsbuild(esbuild);
  mock.module("esbuild", () => patchedEsbuild);
  globalThis.__bunTestCloudflareGuessWorkerFormatPatched = true;
};
