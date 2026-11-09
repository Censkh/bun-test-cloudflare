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

const proxyCallRetentionHelper = `var btcfInFlightProxyCalls = /* @__PURE__ */ new Set();
var btcfHoldUntilSettled = (handler, args, result) => {
  if (!(result instanceof Promise)) return result;
  const call = { handler, args };
  btcfInFlightProxyCalls.add(call);
  const release = () => btcfInFlightProxyCalls.delete(call);
  result.then(release, release);
  return result;
};
`;

/**
 * Miniflare frees a proxy's object on the server 100 ms after the proxy is collected, but nothing
 * keeps a proxy alive during its own call: an async call holds only the proxy's handler, and a
 * Fetcher's fetch not even that once dispatched. Durable Object stubs and fetches are always async
 * and usually short-lived, so on a busy machine a queued call could reach the server after its
 * target was freed and fail with "AssertionError: false == true". Each in-flight call now keeps its
 * handler and arguments, and a handler its proxy, until the call settles.
 */
export const proxyCallRetention: MiniflareSourceTransform = {
  marker: "ProxyStubHandler",
  name: "the platform proxy's call retention",
  replacements: [
    {
      pattern: /var ProxyStubHandler = class extends Function \{/g,
      replace: (match) => `${proxyCallRetentionHelper}${match}`,
    },
    {
      pattern: /const proxy = new Proxy\(proxyTarget, handler\);/g,
      replace: (match) => `${match}\n    handler.btcfProxy = proxy;`,
    },
    {
      pattern:
        /const result = this\.#call\(\s*"__miniflareWrappedFunction",\s*this\.#thisFnKnownAsync,\s*args\[1\],\s*this\s*\);/g,
      replace: (match) => `${match}\n    btcfHoldUntilSettled(this, args[1], result);`,
    },
    {
      pattern: /const result = this\.#call\(key, knownAsync, args, func\);/g,
      replace: (match) => `${match}\n        btcfHoldUntilSettled(this, args, result);`,
    },
  ],
};

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
export const installMiniflareSourcePatch = (enabled: { capnpArenaGrowth: boolean; proxyCallRetention: boolean }) => {
  const transforms = [
    ...(enabled.capnpArenaGrowth ? [capnpArenaGrowth] : []),
    ...(enabled.proxyCallRetention ? [proxyCallRetention] : []),
  ];
  if (transforms.length === 0) return;

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
