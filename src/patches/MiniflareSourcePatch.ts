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

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches the code with any whitespace between its tokens, so reformatting doesn't break it. */
const code = (snippet: string) => new RegExp(snippet.trim().split(/\s+/).map(escapeRegExp).join("\\s*"), "g");

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

const proxyClassMembersHelper = `var btcfProxyClassMembers = /* @__PURE__ */ new Map();
var btcfGetProxyClassMembers = (name) => {
  if (typeof name !== "string" || !(name.startsWith("D1") || name.startsWith("R2") || name === "KvNamespace")) return void 0;
  let members = btcfProxyClassMembers.get(name);
  if (members === void 0) btcfProxyClassMembers.set(name, members = /* @__PURE__ */ new Map());
  return members;
};
`;

/**
 * Miniflare's platform proxy learns, per proxied object, that a property is a method and that the
 * method is async. Each D1 query makes a new prepared statement, so test code paid two blocking
 * round trips to workerd per query (looking up `all` or `run`, then calling it synchronously)
 * before the async call. The storage bindings' classes have fixed prototypes, as Miniflare's own
 * per-object cache already assumes, so the patch remembers both facts per class for them.
 */
export const proxyClassMembers: MiniflareSourceTransform = {
  marker: "ProxyStubHandler",
  name: "the platform proxy's method cache",
  replacements: [
    {
      pattern: code("var ProxyStubHandler = class extends Function {"),
      replace: (match) => `${proxyClassMembersHelper}${match}`,
    },
    {
      // Miniflare 4 writes these ifs without braces.
      pattern:
        /const maybeKnown = this\.#knownValues\.get\(key\);\s*if \(maybeKnown !== void 0\)\s*(?:\{\s*return maybeKnown;\s*\}|return maybeKnown;)/g,
      replace: (match) => `${match}
    if (btcfGetProxyClassMembers(this.target[kName])?.has(key)) {
      const knownFunction = this.#createFunction(key);
      this.#knownValues.set(key, knownFunction);
      return knownFunction;
    }`,
    },
    {
      pattern: code(`if (syncRes.headers.get(CoreHeaders.OP_RESULT_TYPE) === "Function") {`),
      replace: (match) => `${match}
      const btcfClassMembers = btcfGetProxyClassMembers(this.target[kName]);
      if (btcfClassMembers !== void 0 && !btcfClassMembers.has(key)) btcfClassMembers.set(key, false);`,
    },
    {
      pattern: code("#createFunction(key) { let knownAsync = false;"),
      replace: () => `#createFunction(key) {
    const btcfClassMembers = btcfGetProxyClassMembers(this.target[kName]);
    let knownAsync = btcfClassMembers?.get(key) === true;`,
    },
    {
      pattern: /if \(!knownAsync && result instanceof Promise\)\s*(\{)?\s*knownAsync = true;/g,
      replace: (_match, brace) =>
        `if (!knownAsync && result instanceof Promise) {
          knownAsync = true;
          btcfClassMembers?.set(key, true);${brace ? "" : "\n        }"}`,
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
export const installMiniflareSourcePatch = (enabled: { capnpArenaGrowth: boolean; proxyClassMembers: boolean }) => {
  const transforms = [
    ...(enabled.capnpArenaGrowth ? [capnpArenaGrowth] : []),
    ...(enabled.proxyClassMembers ? [proxyClassMembers] : []),
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
