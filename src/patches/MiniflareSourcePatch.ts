import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";

type CompilableModule = Module & {
  _compile(source: string, filename: string): void;
};

type ModuleWithNodeModulePaths = typeof Module & {
  _nodeModulePaths(directory: string): string[];
};

type Replacement = { pattern: RegExp; replace: (match: string, ...groups: string[]) => string };

export type MiniflareSourceTransform = {
  /** Present while Miniflare still contains the code this transform targets in some form. */
  marker: string;
  name: string;
  /** Each must match exactly once, or the transform is skipped as a whole. */
  replacements: Replacement[];
};

const localRequire = require;

/**
 * Miniflare serializes each workerd config with capnp-es (bundled; up to capnp-es 0.0.16 at least),
 * whose single-segment arena grows by only the bytes each allocation needs (at least 4 KiB) and
 * copies the whole buffer every time. A config holding several large Worker bundles (one copy per
 * isolated slot) is over 100 MB, so every small struct written after the modules copies it again:
 * each new workerd generation left gigabytes of discarded ArrayBuffers and blocked the event loop
 * for over a second. Doubling instead makes the copies linear. Only `byteLength` is ever written
 * out, so the serialized bytes are unchanged.
 */
export const capnpArenaGrowth: MiniflareSourceTransform = {
  marker: "MIN_SINGLE_SEGMENT_GROWTH",
  name: "capnp's single-segment arena growth",
  replacements: [
    {
      pattern: /(\w+)\.buffer\s*=\s*new ArrayBuffer\(\s*(\w+)\.byteLength\s*\+\s*(\w+)\s*\)\s*;/g,
      replace: (_match, arena, source, minSize) =>
        `${arena}.buffer = new ArrayBuffer(${source}.byteLength + Math.max(${minSize}, ${source}.byteLength));`,
    },
  ],
};

// Don't cache the platform proxy's methods per class to save its blocking round trips. An in-flight
// async call holds the proxy's handler, not the proxy, so a statement can be collected and freed on
// the server while its call is queued; each new object's first call being synchronous prevents that.

export type MiniflareSourceTransformResult = {
  applied: string[];
  /** Transforms whose target code Miniflare still has, in a shape they no longer match. */
  unmatched: string[];
  source: string;
};

/**
 * Applies each transform whose replacements all match exactly once, and leaves the rest of the
 * source alone: these patches only save time and memory, so a Miniflare version they don't fit
 * runs unpatched rather than failing.
 */
export const applyMiniflareSourceTransforms = (
  source: string,
  transforms: MiniflareSourceTransform[],
): MiniflareSourceTransformResult => {
  const result: MiniflareSourceTransformResult = { applied: [], unmatched: [], source };
  for (const transform of transforms) {
    let patched = result.source;
    const matchesOnce = transform.replacements.every(({ pattern }) => (patched.match(pattern) ?? []).length === 1);
    if (!matchesOnce) {
      if (result.source.includes(transform.marker)) result.unmatched.push(transform.name);
      continue;
    }
    for (const { pattern, replace } of transform.replacements) {
      patched = patched.replace(pattern, replace as (substring: string, ...args: any[]) => string);
    }
    result.source = patched;
    result.applied.push(transform.name);
  }
  return result;
};

const warn = (message: string) => process.stderr.write(`[bun-test-cloudflare] ${message}\n`);

/**
 * Loads Wrangler's Miniflare into the module cache with the enabled transforms applied, under its own
 * path, so every later `require` shares the patched exports. Install after the undici and ws mocks
 * and before anything else loads Miniflare: its bundle requires its dependencies now.
 */
export const installMiniflareSourcePatch = () => {
  const transforms = [capnpArenaGrowth];

  const wranglerPackageJsonPath = localRequire.resolve("wrangler/package.json");
  const miniflarePath = localRequire.resolve("miniflare", { paths: [path.dirname(wranglerPackageJsonPath)] });
  if (localRequire.cache[miniflarePath]) {
    warn("Miniflare loaded before the setup preload, so it runs without the harness's Miniflare patches.");
    return;
  }

  const {
    applied,
    source: patchedSource,
    unmatched,
  } = applyMiniflareSourceTransforms(readFileSync(miniflarePath, "utf8"), transforms);
  for (const name of unmatched) {
    warn(
      `This Miniflare version's ${name} doesn't match the harness's patch, so it runs unpatched (${miniflarePath}).`,
    );
  }
  if (applied.length === 0) return;

  const miniflareModule = new Module(miniflarePath) as CompilableModule;
  miniflareModule.filename = miniflarePath;
  miniflareModule.paths = (Module as ModuleWithNodeModulePaths)._nodeModulePaths(path.dirname(miniflarePath));
  localRequire.cache[miniflarePath] = miniflareModule;
  try {
    miniflareModule._compile(patchedSource, miniflarePath);
  } catch (error) {
    // A patch that no longer fits this version's code fails to parse, before Miniflare runs.
    delete localRequire.cache[miniflarePath];
    warn(`The patched Miniflare failed to load, so it runs unpatched: ${String(error)}`);
    return;
  }
  miniflareModule.loaded = true;
};
