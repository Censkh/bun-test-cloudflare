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
const singleSegmentGrowth = "s.buffer = new ArrayBuffer(srcBuffer.byteLength + minSize);";
const singleSegmentArenaMarker = "MIN_SINGLE_SEGMENT_GROWTH";

/**
 * Miniflare serializes each workerd config with capnp-es, whose single-segment arena grows by only
 * the bytes each allocation needs (at least 4 KiB) and copies the whole buffer every time. A config
 * holding several large Worker bundles (one copy per isolated slot) is over 100 MB, so every small
 * struct written after the modules copies it again: each new workerd generation left gigabytes of
 * discarded ArrayBuffers and blocked the event loop for over a second. Doubling instead makes the
 * copies linear. Only `byteLength` is ever written out, so the serialized bytes are unchanged.
 * Returns the source unchanged when the arena has no such growth.
 */
export const patchCapnpSingleSegmentGrowth = (source: string) =>
  source.replace(
    singleSegmentGrowth,
    "s.buffer = new ArrayBuffer(srcBuffer.byteLength + Math.max(minSize, srcBuffer.byteLength));",
  );

/**
 * Loads Wrangler's Miniflare into the module cache with the arena patched, under its own path, so
 * every later `require` shares the patched exports. Install after the undici and ws mocks and before
 * anything else loads Miniflare: its bundle requires its dependencies now.
 */
export const installMiniflareCapnpArenaPatch = () => {
  const wranglerPackageJsonPath = localRequire.resolve("wrangler/package.json");
  const miniflarePath = localRequire.resolve("miniflare", { paths: [path.dirname(wranglerPackageJsonPath)] });
  if (localRequire.cache[miniflarePath]) {
    throw new Error("bun-test-cloudflare must patch Miniflare's capnp arena before Miniflare loads");
  }

  const source = readFileSync(miniflarePath, "utf8");
  const patchedSource = patchCapnpSingleSegmentGrowth(source);
  if (patchedSource === source) {
    if (source.includes(singleSegmentArenaMarker)) {
      throw new Error(
        `bun-test-cloudflare could not find capnp's single-segment arena growth in ${miniflarePath}; update MiniflareCapnpArenaPatch for this Miniflare version.`,
      );
    }
    return;
  }

  const miniflareModule = new Module(miniflarePath) as CompilableModule;
  miniflareModule.filename = miniflarePath;
  miniflareModule.paths = (Module as ModuleWithNodeModulePaths)._nodeModulePaths(path.dirname(miniflarePath));
  localRequire.cache[miniflarePath] = miniflareModule;
  try {
    miniflareModule._compile(patchedSource, miniflarePath);
  } catch (error) {
    delete localRequire.cache[miniflarePath];
    throw error;
  }
  miniflareModule.loaded = true;
};
