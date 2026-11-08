import { readFileSync } from "node:fs";
import Module from "node:module";
import path from "node:path";

type CompilableModule = Module & {
  _compile(source: string, filename: string): void;
};

type ModuleWithNodeModulePaths = typeof Module & {
  _nodeModulePaths(directory: string): string[];
};

type SourceTransform = {
  /** Text the transform's target code contains; when present and unmatched, the patch must be updated. */
  marker: string;
  name: string;
  replacements: Array<[from: string, to: string]>;
};

const localRequire = require;

/**
 * Miniflare serializes each workerd config with capnp-es, whose single-segment arena grows by only
 * the bytes each allocation needs (at least 4 KiB) and copies the whole buffer every time. A config
 * holding several large Worker bundles (one copy per isolated slot) is over 100 MB, so every small
 * struct written after the modules copies it again: each new workerd generation left gigabytes of
 * discarded ArrayBuffers and blocked the event loop for over a second. Doubling instead makes the
 * copies linear. Only `byteLength` is ever written out, so the serialized bytes are unchanged.
 */
const capnpArenaGrowth: SourceTransform = {
  marker: "MIN_SINGLE_SEGMENT_GROWTH",
  name: "capnp's single-segment arena growth",
  replacements: [
    [
      "s.buffer = new ArrayBuffer(srcBuffer.byteLength + minSize);",
      "s.buffer = new ArrayBuffer(srcBuffer.byteLength + Math.max(minSize, srcBuffer.byteLength));",
    ],
  ],
};

/**
 * Miniflare's platform proxy learns, per proxied object, that a property is a method and that the
 * method is async. Each D1 query makes a new prepared statement, so test code paid two blocking
 * round trips to workerd per query (looking up `all` or `run`, then calling it synchronously)
 * before the async call. The storage bindings' classes have fixed prototypes, as Miniflare's own
 * per-object cache already assumes, so the patch remembers both facts per class for them.
 */
const proxyClassMembers: SourceTransform = {
  marker: "var ProxyStubHandler = class extends Function {",
  name: "the platform proxy's method cache",
  replacements: [
    [
      "var ProxyStubHandler = class extends Function {",
      `var btcfProxyClassMembers = /* @__PURE__ */ new Map();
var btcfGetProxyClassMembers = (name) => {
  if (typeof name !== "string" || !(name.startsWith("D1") || name.startsWith("R2") || name === "KvNamespace")) return void 0;
  let members = btcfProxyClassMembers.get(name);
  if (members === void 0) btcfProxyClassMembers.set(name, members = /* @__PURE__ */ new Map());
  return members;
};
var ProxyStubHandler = class extends Function {`,
    ],
    [
      `    const maybeKnown = this.#knownValues.get(key);
    if (maybeKnown !== void 0) {
      return maybeKnown;
    }
    const syncRes = this.bridge.sync.fetch(this.bridge.url, {`,
      `    const maybeKnown = this.#knownValues.get(key);
    if (maybeKnown !== void 0) {
      return maybeKnown;
    }
    if (btcfGetProxyClassMembers(this.target[kName])?.has(key)) {
      const knownFunction = this.#createFunction(key);
      this.#knownValues.set(key, knownFunction);
      return knownFunction;
    }
    const syncRes = this.bridge.sync.fetch(this.bridge.url, {`,
    ],
    [
      `    if (syncRes.headers.get(CoreHeaders.OP_RESULT_TYPE) === "Function") {
      result = this.#createFunction(key);`,
      `    if (syncRes.headers.get(CoreHeaders.OP_RESULT_TYPE) === "Function") {
      const classMembers = btcfGetProxyClassMembers(this.target[kName]);
      if (classMembers !== void 0 && !classMembers.has(key)) classMembers.set(key, false);
      result = this.#createFunction(key);`,
    ],
    [
      `  #createFunction(key) {
    let knownAsync = false;
    const func = {
      [key]: (...args) => {
        const result = this.#call(key, knownAsync, args, func);
        if (!knownAsync && result instanceof Promise) {
          knownAsync = true;
        }`,
      `  #createFunction(key) {
    const classMembers = btcfGetProxyClassMembers(this.target[kName]);
    let knownAsync = classMembers?.get(key) === true;
    const func = {
      [key]: (...args) => {
        const result = this.#call(key, knownAsync, args, func);
        if (!knownAsync && result instanceof Promise) {
          knownAsync = true;
          classMembers?.set(key, true);
        }`,
    ],
  ],
};

/** Applies a transform, or returns the source unchanged when it has none of the target code. */
export const applyMiniflareSourceTransform = (source: string, transform: SourceTransform, sourcePath: string) => {
  if (!source.includes(transform.marker)) return source;
  let patched = source;
  for (const [from, to] of transform.replacements) {
    if (!patched.includes(from)) {
      throw new Error(
        `bun-test-cloudflare could not find ${transform.name} in ${sourcePath}; update MiniflareSourcePatch for this Miniflare version.`,
      );
    }
    patched = patched.replace(from, to);
  }
  return patched;
};

/**
 * Loads Wrangler's Miniflare into the module cache with the enabled transforms applied, under its own
 * path, so every later `require` shares the patched exports. Install after the undici and ws mocks
 * and before anything else loads Miniflare: its bundle requires its dependencies now.
 */
export const installMiniflareSourcePatch = (enabled: { capnpArenaGrowth: boolean; proxyClassMembers: boolean }) => {
  const transforms = [
    ...(enabled.capnpArenaGrowth ? [capnpArenaGrowth] : []),
    ...(enabled.proxyClassMembers ? [proxyClassMembers] : []),
  ];
  if (transforms.length === 0) return;

  const wranglerPackageJsonPath = localRequire.resolve("wrangler/package.json");
  const miniflarePath = localRequire.resolve("miniflare", { paths: [path.dirname(wranglerPackageJsonPath)] });
  if (localRequire.cache[miniflarePath]) {
    throw new Error("bun-test-cloudflare must patch Miniflare's source before Miniflare loads");
  }

  const source = readFileSync(miniflarePath, "utf8");
  const patchedSource = transforms.reduce(
    (patched, transform) => applyMiniflareSourceTransform(patched, transform, miniflarePath),
    source,
  );
  if (patchedSource === source) return;

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
