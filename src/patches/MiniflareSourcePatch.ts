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
 * out, so the serialized bytes are unchanged. Miniflare 5's capnp-es already grows by at least the
 * buffer's own length and no longer clamps `minSize` itself, so the transform leaves it alone.
 */
export const capnpArenaGrowth: MiniflareSourceTransform = {
  marker: "minSize < MIN_SINGLE_SEGMENT_GROWTH",
  name: "capnp's single-segment arena growth",
  replacements: [
    {
      pattern: /(\w+)\.buffer\s*=\s*new ArrayBuffer\(\s*(\w+)\.byteLength\s*\+\s*(minSize)\s*\)\s*;/g,
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
      // Miniflare 5 assigns the class inside its module's lazy initializer instead of declaring it.
      pattern: /(?:var )?ProxyStubHandler = class extends Function \{/g,
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

/**
 * Miniflare stops its loopback server with stoppable, which counts each socket's requests and, on
 * `dispose()`, ends every socket it still tracks. Bun detaches `req.socket` once a response is
 * written, so stoppable's `finish` handler stored the count under `null` and its forced close then
 * threw "null is not an object (evaluating 'socket.end')" from a timer, failing whichever test was
 * running when a harness disposed a Miniflare. Each request now keeps the socket it arrived on, and
 * a socket that has already closed isn't tracked again.
 */
export const stoppableSocketTracking: MiniflareSourceTransform = {
  marker: "reqsPerSocket.set(req.socket",
  name: "stoppable's per-socket request tracking",
  replacements: [
    {
      pattern:
        /function onRequest\(req, res\) \{\s*reqsPerSocket\.set\(req\.socket, reqsPerSocket\.get\(req\.socket\) \+ 1\);\s*res\.once\("finish", \(\) => \{\s*const pending = reqsPerSocket\.get\(req\.socket\) - 1;\s*reqsPerSocket\.set\(req\.socket, pending\);\s*if \(stopped && pending === 0\) \{\s*req\.socket\.end\(\);\s*\}\s*\}\);\s*\}/g,
      replace: () => `function onRequest(req, res) {
        const socket = req.socket;
        if (!reqsPerSocket.has(socket)) return;
        reqsPerSocket.set(socket, reqsPerSocket.get(socket) + 1);
        res.once("finish", () => {
          if (!reqsPerSocket.has(socket)) return;
          const pending = reqsPerSocket.get(socket) - 1;
          reqsPerSocket.set(socket, pending);
          if (stopped && pending === 0) {
            socket.end();
          }
        });
      }`,
    },
  ],
};

/**
 * Miniflare's loopback server hands each incoming request's body to a Request as a stream that reads
 * the Node request and closes in a microtask once it ends or fails. When the body's consumer cancels
 * while a read is pending, that read still settles, and the queued close then threw "Invalid state:
 * Controller is already closed" with no stack, failing whichever test was running. A cancelled body
 * now ignores its last read.
 */
export const loopbackBodyCancellation: MiniflareSourceTransform = {
  marker: "function safeReadableStreamFrom(",
  name: "the loopback request body's cancellation",
  replacements: [
    {
      pattern:
        /function safeReadableStreamFrom\(iterable\) \{\s*let (\w+);\s*return new ([\w$]+)\.ReadableStream\(\{\s*async start\(\) \{\s*\1 = iterable\[Symbol\.asyncIterator\]\(\);\s*\},(?:\s*\/\/[^\n]*)?\s*async pull\(controller\) \{\s*try \{\s*const \{ done, value \} = await \1\.next\(\);\s*if \(done\) \{\s*queueMicrotask\(\(\) => controller\.close\(\)\);\s*\} else \{\s*const buf = Buffer\.isBuffer\(value\) \? value : Buffer\.from\(value\);\s*controller\.enqueue\(new Uint8Array\(buf\)\);\s*\}\s*\} catch \{\s*queueMicrotask\(\(\) => controller\.close\(\)\);\s*\}\s*return controller\.desiredSize > 0;\s*\},\s*async cancel\(\) \{\s*await \1\.return\?\.\(\);\s*\}\s*\}\);\s*\}/g,
      replace: (_match, iterator, web) => `function safeReadableStreamFrom(iterable) {
  let ${iterator};
  let ended = false;
  const end = (controller) => queueMicrotask(() => {
    if (ended) return;
    ended = true;
    controller.close();
  });
  return new ${web}.ReadableStream({
    async start() {
      ${iterator} = iterable[Symbol.asyncIterator]();
    },
    async pull(controller) {
      try {
        const { done, value } = await ${iterator}.next();
        if (ended) return;
        if (done) {
          end(controller);
        } else {
          const buf = Buffer.isBuffer(value) ? value : Buffer.from(value);
          controller.enqueue(new Uint8Array(buf));
        }
      } catch {
        end(controller);
      }
      return controller.desiredSize > 0;
    },
    async cancel() {
      ended = true;
      await ${iterator}.return?.();
    }
  });
}`,
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
export const installMiniflareSourcePatch = (enabled: {
  capnpArenaGrowth: boolean;
  proxyCallRetention: boolean;
  stoppableSocketTracking: boolean;
  loopbackBodyCancellation: boolean;
}) => {
  const transforms = [
    ...(enabled.capnpArenaGrowth ? [capnpArenaGrowth] : []),
    ...(enabled.proxyCallRetention ? [proxyCallRetention] : []),
    ...(enabled.stoppableSocketTracking ? [stoppableSocketTracking] : []),
    ...(enabled.loopbackBodyCancellation ? [loopbackBodyCancellation] : []),
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
