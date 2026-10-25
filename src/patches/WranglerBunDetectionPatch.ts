import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";

type CompilableModule = Module & {
  _compile(source: string, filename: string): void;
};

type ModuleWithNodeModulePaths = typeof Module & {
  _nodeModulePaths(directory: string): string[];
};

const localRequire = require;
const isBunFunction = /function isBun\(\) \{\s*return !!process\.versions\.bun;\s*\}/;
const bunRefusalMarker = "BUN_UNSUPPORTED_MESSAGE";

/**
 * Wrangler >=4.151.3 refuses to dispatch requests under Bun because Bun's own fetch() ignores the
 * undici dispatcher Miniflare routes them through (oven-sh/bun#39247). The undici patch hands
 * Miniflare the real undici package, whose fetch() honours the dispatcher, so Wrangler's Bun check
 * reports Node for the harness. Returns the source unchanged when Wrangler has no such check.
 */
export const patchWranglerBunDetection = (source: string) =>
  source.replace(isBunFunction, "function isBun() {\n  return false;\n}");

/**
 * Loads the patched bundle into the module cache under Wrangler's own path, so `import` and
 * `require` share its exports object (the dev env patches replace `exports.unstable_DevEnv`, which
 * Wrangler constructs). Install after every module mock: the bundle requires its dependencies now.
 */
export const installWranglerBunDetectionPatch = () => {
  const wranglerPath = localRequire.resolve("wrangler");
  if (localRequire.cache[wranglerPath]) {
    return;
  }

  const source = readFileSync(wranglerPath, "utf8");
  const patchedSource = patchWranglerBunDetection(source);
  if (patchedSource === source) {
    if (source.includes(bunRefusalMarker)) {
      throw new Error(
        `bun-test-cloudflare could not find Wrangler's Bun check in ${wranglerPath}; update WranglerBunDetectionPatch for this Wrangler version.`,
      );
    }
    return;
  }

  const wranglerModule = new Module(wranglerPath) as CompilableModule;
  wranglerModule.filename = wranglerPath;
  wranglerModule.paths = (Module as ModuleWithNodeModulePaths)._nodeModulePaths(path.dirname(wranglerPath));
  localRequire.cache[wranglerPath] = wranglerModule;
  try {
    wranglerModule._compile(patchedSource, wranglerPath);
  } catch (error) {
    delete localRequire.cache[wranglerPath];
    throw error;
  }
  wranglerModule.loaded = true;
};
