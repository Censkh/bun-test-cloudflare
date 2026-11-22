import crypto from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { semver } from "bun";
import type { TestHarnessOptions } from "wrangler";
import { unstable_convertConfigBindingsToStartWorkerBindings } from "wrangler";
import {
  BTCF_META_HEADER,
  BTCF_ORIGIN_HEADER,
  BTCF_RUN_ID_HEADER,
  BTCF_SECRET_HEADER,
  BTCF_WORKER_HEADER,
  type FencedBindingDescriptor,
  type FencedWorkerSpec,
} from "./FencedEnvBridge";

const slotCompatibilityDate = "2026-06-30";

type WorkerInput = TestHarnessOptions["workers"][number];
type InlineWorkerInput = Extract<WorkerInput, { config: unknown }>;

export type FencedWorkerSlots = {
  cleanupDir: string;
  inputs: WorkerInput[];
  secret: string;
  slotSupervisorNames: string[];
  workerSpecs: FencedWorkerSpec[];
};

const RUNTIME_FILES = [
  "WorkerdCache.ts",
  "WorkerdD1.ts",
  "WorkerdDurableObject.ts",
  "WorkerdKV.ts",
  "WorkerdQueue.ts",
  "WorkerdR2.ts",
  "WorkerdRateLimit.ts",
  "WorkerdRun.ts",
  "WorkerdWorkflow.ts",
] as const;

let cachedTranspiledRuntime: Record<string, string> | undefined;

const getTranspiledRuntime = (): Record<string, string> => {
  if (cachedTranspiledRuntime) return cachedTranspiledRuntime;
  const transpiler = new Bun.Transpiler({ loader: "ts" });
  const modules: Record<string, string> = {};
  for (const file of RUNTIME_FILES) {
    const source = readFileSync(path.join(import.meta.dir, file), "utf8");
    const transformed = transpiler
      .transformSync(source)
      .replace(/from\s+["']\.\/(Workerd[A-Za-z0-9]+)["']/g, 'from "./$1.js"');
    modules[file.replace(/\.ts$/, ".js")] = transformed;
  }
  cachedTranspiledRuntime = modules;
  return modules;
};

const getInlineConfig = (input: WorkerInput) => {
  if (!("config" in input)) {
    throw new Error("Fenced Worker slots require prepared inline Worker configuration");
  }
  return input.config as Record<string, any>;
};

const SHARED_SLOT_BINDINGS = new Set([
  "analytics_engine",
  "assets",
  "hyperdrive",
  "json",
  "plain_text",
  "send_email",
  // Not stored locally, so slots share it, as they share Images.
  "vectorize",
  "version_metadata",
]);

/**
 * Wrangler before 4.108 deletes the rate limits of every Worker but its primary one when it merges
 * their Miniflare options, so a rate limit in any slot past the first was undefined.
 */
export const wranglerKeepsSecondaryRateLimits = (wranglerVersion: string) =>
  semver.satisfies(wranglerVersion, ">=4.108.0");

const wranglerPackage = require("wrangler/package.json") as { version: string; dependencies: { workerd: string } };
const slotsKeepRateLimits = wranglerKeepsSecondaryRateLimits(wranglerPackage.version);
// Earlier workerd releases cannot serialize these wrapped bindings into a Worker Loader's env.
const slotsCanLoadWrappedBindings = semver.satisfies(wranglerPackage.dependencies.workerd, ">=1.20260807.2");

export const isSupportedSlotBinding = (
  binding: { [key: string]: unknown; type: string },
  workerNames: Set<string>,
): boolean => {
  if (binding.type === "images" || binding.type === "browser") return slotsCanLoadWrappedBindings;
  if (binding.type === "d1") return typeof binding.database_id === "string";
  if (binding.type === "kv_namespace") return typeof binding.id === "string";
  if (binding.type === "r2_bucket") return typeof binding.bucket_name === "string";
  if (binding.type === "durable_object_namespace") {
    return (
      typeof binding.class_name === "string" &&
      (binding.script_name === undefined ||
        (typeof binding.script_name === "string" && workerNames.has(binding.script_name)))
    );
  }
  if (binding.type === "service") {
    return typeof binding.service === "string" && workerNames.has(binding.service);
  }
  if (binding.type === "queue") return typeof binding.queue_name === "string";
  if (binding.type === "ratelimit") return slotsKeepRateLimits && typeof binding.namespace_id === "string";
  if (binding.type === "workflow") {
    return (
      typeof binding.name === "string" &&
      typeof binding.class_name === "string" &&
      (binding.script_name === undefined ||
        (typeof binding.script_name === "string" && workerNames.has(binding.script_name)))
    );
  }
  return SHARED_SLOT_BINDINGS.has(binding.type);
};

export const canUseFencedWorkerSlots = (workers: Array<{ input: WorkerInput; name: string }>): boolean => {
  const workerNames = new Set(workers.map((worker) => worker.name));
  try {
    return workers.every(({ input }) => {
      const config = getInlineConfig(input);
      if (Array.isArray(config.containers) && config.containers.length > 0) return false;
      const bindings = unstable_convertConfigBindingsToStartWorkerBindings(config);
      return Object.values(bindings).every((binding) =>
        isSupportedSlotBinding(binding as { [key: string]: unknown; type: string }, workerNames),
      );
    });
  } catch {
    return false;
  }
};

const appendSlot = (value: string, slot: number) => `${value}--btcf-slot-${slot}`;

const getSupervisorName = (slot: number) => `__btcf-supervisor--slot-${slot}`;
/** The runtime's one copy of every fenced Worker's code, which each slot's supervisor loads from. */
const MODULE_STORE_NAME = "__btcf-module-store";

/** The Worker that hosts a Worker's Durable Object and Workflow classes for every slot. */
const getDoHostName = (workerName: string) => {
  const suffix = "--btcf-do";
  return `${workerName.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
};

/** A slot's copy of a Durable Object or Workflow class in its Worker's host. */
const getSlotClassName = (className: string, slot: number) => `${className}__btcf_slot${slot}`;

const linkOrCopy = (source: string, destination: string) => {
  mkdirSync(path.dirname(destination), { recursive: true });
  try {
    linkSync(source, destination);
  } catch {
    copyFileSync(source, destination);
  }
};

type CollectedModule = {
  kind: "js" | "cjs" | "text" | "data" | "wasm";
  relPath: string;
  sourcePath: string;
};

const matchesAnyGlob = (relPath: string, globs: string[] | undefined): boolean => {
  if (!globs || globs.length === 0) return false;
  return globs.some((pattern) => new Bun.Glob(pattern).match(relPath));
};

const classifyModuleKind = (
  relPath: string,
  rules: Array<{ type?: string; globs?: string[] }> | undefined,
): CollectedModule["kind"] | undefined => {
  if (
    relPath === "wrangler.json" ||
    relPath.endsWith(".map") ||
    relPath.includes(".cache-bridge.") ||
    relPath.includes(".cache-namespace.") ||
    relPath.includes(".btcf-do-host.") ||
    relPath.startsWith("btcf-runtime/")
  ) {
    return undefined;
  }
  if (rules) {
    for (const rule of rules) {
      if (!matchesAnyGlob(relPath, rule.globs)) continue;
      if (rule.type === "CompiledWasm") return "wasm";
      if (rule.type === "Data") return "data";
      if (rule.type === "Text") return "text";
      if (rule.type === "CommonJS") return "cjs";
      if (rule.type === "ESModule") return "js";
    }
  }
  if (relPath.endsWith(".wasm") || relPath.endsWith(".wasm?module")) return "wasm";
  if (relPath.endsWith(".cjs")) return "cjs";
  if (relPath.endsWith(".js") || relPath.endsWith(".mjs")) return "js";
  return undefined;
};

const collectWorkerModules = (
  baseDir: string,
  rules: Array<{ type?: string; globs?: string[] }> | undefined,
): CollectedModule[] => {
  const collected: CollectedModule[] = [];
  const walk = (currentDir: string) => {
    for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(baseDir, fullPath).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (relPath === "btcf-runtime") continue;
        walk(fullPath);
        continue;
      }
      const kind = classifyModuleKind(relPath, rules);
      if (kind) collected.push({ kind, relPath, sourcePath: fullPath });
    }
  };
  if (existsSync(baseDir) && statSync(baseDir).isDirectory()) {
    walk(baseDir);
  }
  return collected;
};

const collectOwnedDoClasses = (workers: Array<{ input: WorkerInput; name: string }>): Map<string, Set<string>> => {
  const owned = new Map<string, Set<string>>();
  const add = (workerName: string, className: string) => {
    let classes = owned.get(workerName);
    if (!classes) owned.set(workerName, (classes = new Set()));
    classes.add(className);
  };
  for (const worker of workers) {
    const config = getInlineConfig(worker.input);
    for (const binding of config.durable_objects?.bindings ?? []) {
      const targetWorker = typeof binding.script_name === "string" ? binding.script_name : worker.name;
      if (typeof binding.class_name === "string") add(targetWorker, binding.class_name);
    }
    for (const migration of config.migrations ?? []) {
      for (const cls of migration.new_classes ?? []) add(worker.name, cls);
      for (const cls of migration.new_sqlite_classes ?? []) add(worker.name, cls);
      for (const renamed of migration.renamed_classes ?? []) {
        if (typeof renamed.to === "string") add(worker.name, renamed.to);
      }
      for (const transferred of migration.transferred_classes ?? []) {
        if (typeof transferred.to === "string") add(worker.name, transferred.to);
      }
    }
  }
  return owned;
};

const writeDoHostWrapper = (options: {
  baseDir: string;
  classes: string[];
  /** The Workflow classes the Worker owns, each run by a wrapper that gives it its run's bindings. */
  workflowClasses: string[];
  /** The slot's binding for each Durable Object class the Worker owns, for its run's `ctx.exports`. */
  exportedDoBindings: Record<string, string>;
  main: string;
  slotCount: number;
  secret: string;
  spec: FencedWorkerSpec;
  workerName: string;
}): { wrapperPath: string; runtimeFiles: string[] } => {
  const { baseDir, classes, exportedDoBindings, main, secret, slotCount, spec, workerName, workflowClasses } = options;
  const slotExports = (className: string, factory: string) =>
    Array.from(
      { length: slotCount },
      (_, slot) =>
        `export class ${getSlotClassName(className, slot)} extends ${factory}(${JSON.stringify(`__BTCF_SLOT_PROXY_${slot}`)}) {}`,
    ).join("\n");
  const runtimeDir = path.join(baseDir, "btcf-runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const runtimeModules = getTranspiledRuntime();
  const runtimeFiles: string[] = [];
  for (const [filename, code] of Object.entries(runtimeModules)) {
    const target = path.join(runtimeDir, filename);
    if (!existsSync(target)) writeFileSync(target, code);
    runtimeFiles.push(`btcf-runtime/${filename}`);
  }

  const mainRel = `./${path.relative(baseDir, main).split(path.sep).join("/")}`;
  const wrapperName = `${workerName}.${secret.slice(0, 8)}.btcf-do-host.js`;
  const wrapperPath = path.join(baseDir, wrapperName);

  const classDecls = classes
    .map(
      (className) => `
// Each slot's copy of ${className}, run against that slot's supervisor (SLOT_PROXY).
const __wrapDurableObject_${className} = (SLOT_PROXY) => class extends DurableObject {
  #instance;
  #runId;
  #originalName;
  #vars;

  constructor(ctx, env) {
    super(ctx, env);
    const identity = parseRunObjectIdentity(ctx.id.name);
    this.#runId = identity?.runId;
    this.#originalName = identity?.name;
  }

  #getRunId() {
    if (!this.#runId) throw new Error("Missing runId on fenced Durable Object ${className}");
    return this.#runId;
  }

  // The run's vars, read once: an instance serves one run.
  #getVars() {
    this.#vars ??= this.env[SLOT_PROXY].getByName("slot").getRuntimeVars(WORKER_NAME);
    return this.#vars;
  }

  #getInstance() {
    this.#instance ??= (async () => {
      const runId = this.#getRunId();
      const proxy = this.env[SLOT_PROXY].getByName("slot");
      const fencedEnv = buildDoFencedEnv(runId, proxy, this.env, await this.#getVars());
      const OriginalClass = __userModule[${JSON.stringify(className)}];
      if (!OriginalClass) throw new Error("Missing Durable Object export ${className}");
      return new OriginalClass(fenceCtx(this.ctx, runId, proxy), fencedEnv);
    })();
    return this.#instance;
  }

  // Runs fn as the run: its caches, and its vars in process.env.
  async #withCaches(runId, proxy, fn) {
    const storage = createRunCacheStorage((op) => proxy.invoke(runId, { name: "cache", args: [op] }));
    const vars = (await this.#getVars()) ?? {};
    return cachesAls.run(storage, () => runVarsAls.run(vars, fn));
  }

  async __btcf_rpc(prop, args) {
    const runId = this.#getRunId();
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      return await instance[prop](...args);
    });
  }

  async fetch(request) {
    const runId = this.#getRunId();
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      return await instance.fetch(request);
    });
  }

  async alarm(alarmInfo) {
    const runId = this.#runId;
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.#instance = undefined;
      return;
    }
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      if (typeof instance.alarm === "function") {
        return await instance.alarm(alarmInfo);
      }
    });
  }

  async webSocketMessage(ws, message) {
    const runId = this.#runId;
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      if (typeof instance.webSocketMessage === "function") return await instance.webSocketMessage(ws, message);
    });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const runId = this.#runId;
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      if (typeof instance.webSocketClose === "function") {
        return await instance.webSocketClose(ws, code, reason, wasClean);
      }
    });
  }

  async webSocketError(ws, error) {
    const runId = this.#runId;
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = await this.#getInstance();
      if (typeof instance.webSocketError === "function") return await instance.webSocketError(ws, error);
    });
  }

  async __btcf_destroy() {
    this.#instance = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
};
${slotExports(className, `__wrapDurableObject_${className}`)}
`,
    )
    .join("\n");

  const workflowDecls = workflowClasses
    .map(
      (className) => `
// Each slot's copy of the ${className} Workflow, run against that slot's supervisor (SLOT_PROXY).
const __wrapWorkflow_${className} = (SLOT_PROXY) => class extends WorkflowEntrypoint {
  async run(event, step) {
    const { __btcf_run: runId, params } = event.payload ?? {};
    if (!runId) throw new Error("Missing runId on fenced Workflow ${className}");
    const proxy = this.env[SLOT_PROXY].getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    const OriginalClass = __userModule[${JSON.stringify(className)}];
    if (!OriginalClass) throw new Error("Missing Workflow export ${className}");
    const runtimeVars = await proxy.getRuntimeVars(WORKER_NAME);
    const fencedEnv = buildDoFencedEnv(runId, proxy, this.env, runtimeVars);
    const instance = new OriginalClass(fenceCtx(this.ctx, runId, proxy), fencedEnv);
    const storage = createRunCacheStorage((op) => proxy.invoke(runId, { name: "cache", args: [op] }));
    return cachesAls.run(storage, () =>
      runVarsAls.run(runtimeVars ?? {}, () =>
        instance.run({ ...event, instanceId: unscopeRunWorkflowInstanceId(event.instanceId), payload: params }, step),
      ),
    );
  }
};
${slotExports(className, `__wrapWorkflow_${className}`)}
`,
    )
    .join("\n");

  const code = `import { DurableObject, WorkflowEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import * as __userModule from ${JSON.stringify(mainRel)};
import {
  createRunCacheStorage,
  createRunD1Binding,
  createRunDurableObjectNamespace,
  createRunKVBinding,
  createRunQueueBinding,
  createRunR2Binding,
  createRunRateLimitBinding,
  createRunWorkflowBinding,
  parseRunObjectIdentity,
  runEnded,
  unscopeRunWorkflowInstanceId,
} from "./btcf-runtime/WorkerdRun.js";

const SPEC = ${JSON.stringify(spec)};
const WORKER_NAME = ${JSON.stringify(workerName)};
const cachesAls = new AsyncLocalStorage();
const originalCaches = globalThis.caches;

const createScopedCacheProxy = (getCache) => ({
  delete: (request, options) => getCache().then((cache) => cache.delete(request, options)),
  match: (request, options) => getCache().then((cache) => cache.match(request, options)),
  put: (request, response) => getCache().then((cache) => cache.put(request, response)),
});

Object.defineProperty(globalThis, "caches", {
  configurable: true,
  value: {
    default: createScopedCacheProxy(async () => (cachesAls.getStore() ?? originalCaches).default),
    open: async (name) => createScopedCacheProxy(async () => (cachesAls.getStore() ?? originalCaches).open(name)),
  },
});

// process.env holds the host's vars, filled as its isolate starts, and the host serves every
// slot's runs at once: as each run's code reads it, it has the run's vars over the host's, as a run's
// own Worker isolate's would.
const runVarsAls = new AsyncLocalStorage();
if (typeof process !== "undefined" && process.env) {
  const runVar = (key) => {
    const vars = runVarsAls.getStore();
    return vars && typeof key === "string" && typeof vars[key] === "string" ? vars[key] : undefined;
  };
  const view = new Proxy(process.env, {
    get: (target, key) => runVar(key) ?? Reflect.get(target, key),
    has: (target, key) => runVar(key) !== undefined || Reflect.has(target, key),
    ownKeys: (target) => {
      const vars = runVarsAls.getStore() ?? {};
      const own = Object.keys(vars).filter((key) => typeof vars[key] === "string");
      return [...new Set([...Reflect.ownKeys(target), ...own])];
    },
    getOwnPropertyDescriptor: (target, key) => {
      const value = runVar(key);
      return value === undefined
        ? Reflect.getOwnPropertyDescriptor(target, key)
        : { configurable: true, enumerable: true, value, writable: true };
    },
  });
  Object.defineProperty(process, "env", { configurable: true, value: view, writable: true });
}

// The run's vars over the Worker's own, as its Worker's code gets them.
const buildDoFencedEnv = (runId, proxy, rawEnv, runtimeVars) => {
  const invoke = (name, op) => proxy.invoke(runId, { name, args: [op] });
  const env = { ...SPEC.vars, ...(runtimeVars ?? {}) };
  for (const [bindingName, desc] of Object.entries(SPEC.bindings)) {
    if (desc.kind === "d1") env[bindingName] = createRunD1Binding((op) => invoke("d1:" + desc.sup, op));
    else if (desc.kind === "kv") env[bindingName] = createRunKVBinding((op) => invoke("kv:" + desc.sup, op));
    else if (desc.kind === "r2") env[bindingName] = createRunR2Binding((op) => invoke("r2:" + desc.sup, op));
    else if (desc.kind === "queue") env[bindingName] = createRunQueueBinding((op) => invoke("queue:" + desc.sup, op));
    else if (desc.kind === "do") env[bindingName] = createRunDurableObjectNamespace((op) => invoke("do:" + desc.sup, op));
    else if (desc.kind === "ratelimit") env[bindingName] = createRunRateLimitBinding((op) => invoke("ratelimit:" + desc.sup, op));
    else if (desc.kind === "workflow") env[bindingName] = createRunWorkflowBinding((op) => invoke("workflow:" + desc.sup, op));
    else if (desc.kind === "service") {
      const fetch = (input, init) => {
          const req = input instanceof Request && init === undefined ? input : new Request(input, init);
          // The request crosses to the slot's supervisor by RPC, which can't carry its signal: it
          // goes without one, and the signal aborts the call here instead.
          const signal = req.signal;
          signal?.throwIfAborted();
          const sent = invoke("service:" + desc.target, new Request(req, { signal: null }));
          if (!signal) return sent;
          return new Promise((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener("abort", abort, { once: true });
            sent.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
          });
      };
      // Its entrypoint's RPC methods go to the slot's supervisor, which calls them as this run.
      env[bindingName] = new Proxy(
        { fetch },
        {
          get: (target, property) =>
            property in target || typeof property === "symbol" || property === "then"
              ? target[property]
              : (...args) => invoke("servicecall:" + desc.target, { method: String(property), args }),
        },
      );
    } else if (desc.kind === "send_email") {
      env[bindingName] = { send: (msg) => invoke("email:" + desc.sup, msg) };
    } else if (desc.kind === "analytics_engine") {
      env[bindingName] = { writeDataPoint: (event) => { void invoke("ae:" + desc.sup, event).catch(() => {}); } };
    } else if (desc.kind === "native") {
      env[bindingName] = rawEnv[desc.sup];
    }
  }
  return env;
};

// A run's code reaching its own Durable Objects through ctx.exports gets the run's namespaces, as
// its bindings are: the host's own exports are the slot's wrappers, outside any run.
const EXPORTED_DO_BINDINGS = ${JSON.stringify(exportedDoBindings)};
// The base classes take only a real ctx, so its exports are replaced on the ctx itself; each Durable
// Object or Workflow instance serves one run.
const fenceCtx = (ctx, runId, proxy) => {
  const raw = ctx.exports ?? {};
  const exports = new Proxy(raw, {
    get(target, name) {
      const sup = EXPORTED_DO_BINDINGS[name];
      if (sup) return createRunDurableObjectNamespace((op) => proxy.invoke(runId, { name: "do:" + sup, args: [op] }));
      return Reflect.get(target, name);
    },
  });
  Object.defineProperty(ctx, "exports", { configurable: true, value: exports });
  return ctx;
};

export default { fetch: () => new Response("DO host", { status: 404 }) };
${classDecls}
${workflowDecls}
`;
  writeFileSync(wrapperPath, code);
  return { wrapperPath, runtimeFiles };
};

const createDynamicWorkerEntrySource = (spec: FencedWorkerSpec, exportedDoBindings: Record<string, string>): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createRunCacheStorage,
  createRunD1Binding,
  createRunDurableObjectNamespace,
  createRunKVBinding,
  createRunQueueBinding,
  createRunR2Binding,
  createRunRateLimitBinding,
  createRunWorkflowBinding,
} from "./__btcf_runtime/WorkerdRun.js";

// This isolate serves its slot's runs one after another: each call names its run (ctx.props.runId),
// and its code gets that run's env, caches and vars. Module state lasts from run to run, as it does
// from request to request in production.
const SPEC = ${JSON.stringify(spec)};
const EXPORTED_DO_BINDINGS = ${JSON.stringify(exportedDoBindings)};
const RUN_HEADER = "x-btcf-run";
const runAls = new AsyncLocalStorage();
let runEnv;
let cachedUserDefault;

// The current run's caches, wherever its code reaches them from.
Object.defineProperty(globalThis, "caches", {
  configurable: true,
  value: createRunCacheStorage((op) => {
    const run = runAls.getStore();
    if (!run) throw new Error("Cache used outside a fenced run");
    return run.cap.invoke(run.runId, "cache", op);
  }),
});

// process.env holds the Worker's own vars, filled as the isolate started; the current run's are
// over them.
if (typeof process !== "undefined" && process.env) {
  const runVar = (key) => {
    const vars = runAls.getStore()?.vars;
    return vars && typeof key === "string" && typeof vars[key] === "string" ? vars[key] : undefined;
  };
  const view = new Proxy(process.env, {
    get: (target, key) => runVar(key) ?? Reflect.get(target, key),
    has: (target, key) => runVar(key) !== undefined || Reflect.has(target, key),
    ownKeys: (target) => {
      const vars = runAls.getStore()?.vars ?? {};
      return [...new Set([...Reflect.ownKeys(target), ...Object.keys(vars).filter((key) => typeof vars[key] === "string")])];
    },
    getOwnPropertyDescriptor: (target, key) => {
      const value = runVar(key);
      return value === undefined
        ? Reflect.getOwnPropertyDescriptor(target, key)
        : { configurable: true, enumerable: true, value, writable: true };
    },
  });
  Object.defineProperty(process, "env", { configurable: true, value: view, writable: true });
}

// A service binding to another Worker of the slot: its fetch, and its entrypoint's RPC methods.
const serviceBinding = (fetch, call) =>
  new Proxy(
    { fetch },
    {
      get: (target, property) =>
        property in target || typeof property === "symbol" || property === "then"
          ? target[property]
          : (...args) => call(String(property), args),
    },
  );

// A request for another Worker of the slot, as this run's.
const asRun = (runId, input, init) => {
  const request = input instanceof Request && init === undefined ? input : new Request(input, init);
  const headers = new Headers(request.headers);
  headers.set(RUN_HEADER, runId);
  return new Request(request, { headers });
};

// The run's code reaching its own Durable Objects through ctx.exports gets the run's namespaces
// (EXPORTED_DO_BINDINGS names the env binding for each class).
const fenceCtx = (ctx, env) => {
  const raw = ctx.exports ?? {};
  const exports = new Proxy(raw, {
    get: (target, name) => (EXPORTED_DO_BINDINGS[name] ? env[EXPORTED_DO_BINDINGS[name]] : Reflect.get(target, name)),
  });
  Object.defineProperty(ctx, "exports", { configurable: true, value: exports });
  return ctx;
};

const buildEnv = (rawEnv, runId, vars) => {
  const cap = rawEnv.__BTCF_CAPABILITY;
  const invoke = (name, op) => cap.invoke(runId, name, op);
  const env = { ...SPEC.vars, ...(vars ?? {}) };
  for (const [bindingName, desc] of Object.entries(SPEC.bindings)) {
    if (desc.kind === "d1") env[bindingName] = createRunD1Binding((op) => invoke("d1:" + desc.sup, op));
    else if (desc.kind === "kv") env[bindingName] = createRunKVBinding((op) => invoke("kv:" + desc.sup, op));
    else if (desc.kind === "r2") env[bindingName] = createRunR2Binding((op) => invoke("r2:" + desc.sup, op));
    else if (desc.kind === "queue") env[bindingName] = createRunQueueBinding((op) => invoke("queue:" + desc.sup, op));
    else if (desc.kind === "do") {
      const doFetcher = rawEnv["__BTCF_DO_FETCH_" + bindingName];
      env[bindingName] = createRunDurableObjectNamespace(
        (op) => invoke("do:" + desc.sup, op),
        doFetcher
          ? (target, req) => {
              const request = asRun(runId, req);
              request.headers.set("x-btcf-do-target", JSON.stringify(target));
              return doFetcher.fetch(request);
            }
          : undefined,
      );
    }
    else if (desc.kind === "ratelimit") env[bindingName] = createRunRateLimitBinding((op) => invoke("ratelimit:" + desc.sup, op));
    else if (desc.kind === "workflow") env[bindingName] = createRunWorkflowBinding((op) => invoke("workflow:" + desc.sup, op));
    else if (desc.kind === "service") {
      const service = rawEnv["__BTCF_SVC_" + bindingName];
      env[bindingName] = serviceBinding(
        (input, init) => service.fetch(asRun(runId, input, init)),
        (method, args) => service.__btcf_call(runId, method, args),
      );
    } else if (desc.kind === "send_email") env[bindingName] = { send: (msg) => invoke("email:" + desc.sup, msg) };
    else if (desc.kind === "analytics_engine") {
      env[bindingName] = { writeDataPoint: (event) => { void invoke("ae:" + desc.sup, event).catch(() => {}); } };
    } else if (desc.kind === "native") {
      env[bindingName] = rawEnv[desc.sup];
    }
  }
  return env;
};

// The run a call is for, with its env (built once for the run) and vars.
const enterRun = async (rawEnv, ctx) => {
  const runId = ctx.props?.runId;
  if (!runId) throw new Error("Missing run for fenced Worker ${spec.name}");
  if (runEnv?.runId !== runId) {
    const cap = rawEnv.__BTCF_CAPABILITY;
    const vars = (await cap.vars(runId, ${JSON.stringify(spec.name)})) ?? {};
    runEnv = { runId, cap, vars, env: buildEnv(rawEnv, runId, vars) };
  }
  return runEnv;
};

const getUserDefault = async () => {
  if (!cachedUserDefault) {
    const mod = await import(${JSON.stringify(`./${spec.mainModule}`)});
    cachedUserDefault = mod.default;
  }
  return cachedUserDefault;
};

const asRunCall = async (rawEnv, ctx, call) => {
  const run = await enterRun(rawEnv, ctx);
  return runAls.run(run, async () => call(run.env, await getUserDefault()));
};

export default class BtcfDynamicEntry extends WorkerEntrypoint {
  async fetch(request) {
    return asRunCall(this.env, this.ctx, (env, worker) => {
      if (typeof worker === "function") return new worker(fenceCtx(this.ctx, env), env).fetch(request);
      return worker.fetch(request, env, fenceCtx(this.ctx, env));
    });
  }

  async __btcf_queue(payload) {
    return asRunCall(this.env, this.ctx, async (env, worker) => {
      const acked = new Set();
      const retried = new Map();
      const messages = payload.messages.map((m) => ({
        id: m.id,
        timestamp: new Date(m.timestamp),
        attempts: m.attempts,
        body: m.body,
        ack() { acked.add(m.id); retried.delete(m.id); },
        retry(options) { retried.set(m.id, options ?? null); acked.delete(m.id); },
      }));
      const batch = {
        queue: payload.queue,
        metadata: payload.metadata,
        messages,
        ackAll() { for (const m of messages) m.ack(); },
        retryAll(options) { for (const m of messages) m.retry(options); },
      };
      if (typeof worker === "function") {
        await new worker(fenceCtx(this.ctx, env), env).queue(batch);
      } else if (typeof worker.queue === "function") {
        await worker.queue(batch, env, fenceCtx(this.ctx, env));
      }
      return { acked: [...acked], retried: [...retried.entries()] };
    });
  }

  // An RPC method of the Worker's entrypoint, called by another Worker of the slot as this run.
  async __btcf_call(method, args) {
    return asRunCall(this.env, this.ctx, async (env, worker) => {
      const target = typeof worker === "function" ? new worker(fenceCtx(this.ctx, env), env) : worker;
      if (typeof target?.[method] !== "function") throw new TypeError(method + " is not a function");
      return target[method](...args);
    });
  }

  async __btcf_scheduled(controller) {
    return asRunCall(this.env, this.ctx, async (env, worker) => {
      const ctrl = { cron: controller.cron, scheduledTime: controller.scheduledTime, noRetry() {} };
      if (typeof worker === "function") {
        await new worker(fenceCtx(this.ctx, env), env).scheduled(ctrl);
      } else if (typeof worker.scheduled === "function") {
        await worker.scheduled(ctrl, env, fenceCtx(this.ctx, env));
      }
    });
  }
}
`;

export const createFencedWorkerSlots = (
  workers: Array<{ input: WorkerInput; name: string }>,
  slotCount: number,
  options: { d1ResetMode?: "drop" | "truncate" } = {},
): FencedWorkerSlots => {
  const d1ResetMode = options.d1ResetMode ?? "drop";
  const secret = crypto.randomUUID();
  const cleanupDir = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-fenced-"));
  process.once("exit", () => {
    try {
      rmSync(cleanupDir, { force: true, recursive: true });
    } catch {
      // Best-effort cleanup on exit.
    }
  });
  const runtimeDir = path.join(cleanupDir, "runtime");
  mkdirSync(runtimeDir, { recursive: true });
  const runtimeModules = getTranspiledRuntime();
  for (const [filename, code] of Object.entries(runtimeModules)) {
    writeFileSync(path.join(runtimeDir, filename), code);
  }

  // Deduplicate resources across all Workers in the graph.
  const d1ById = new Map<string, { sup: string; config: Record<string, any> }>();
  const kvById = new Map<string, { sup: string; config: Record<string, any> }>();
  const r2ByBucket = new Map<string, { sup: string; config: Record<string, any> }>();
  const queueProducerByName = new Map<string, { sup: string; config: Record<string, any> }>();
  const doByTarget = new Map<string, { sup: string; ownerWorker: string; className: string }>();
  const rateLimitByNs = new Map<string, { sup: string; config: Record<string, any> }>();
  const emailByKey = new Map<string, { sup: string; config: Record<string, any> }>();
  const aeByDataset = new Map<string, { sup: string; config: Record<string, any> }>();
  const hyperdriveById = new Map<string, { sup: string; config: Record<string, any> }>();
  const vectorizeByIndex = new Map<string, { sup: string; config: Record<string, any> }>();
  // Each Workflow, by the Worker whose class runs it: every slot has a copy of its own.
  const workflowByName = new Map<
    string,
    { sup: string; config: Record<string, any>; ownerWorker: string; className: string }
  >();

  let usesImages = false;
  let usesBrowser = false;
  let usesVersionMetadata = false;
  let assetsConfig: Record<string, any> | undefined;

  const queueConsumers: Array<{ workerName: string; originalQueue: string; config: Record<string, any> }> = [];

  const getOrAdd = <T>(map: Map<string, T>, key: string, create: (index: number) => T): T => {
    let existing = map.get(key);
    if (!existing) {
      existing = create(map.size);
      map.set(key, existing);
    }
    return existing;
  };

  const workerSpecs: FencedWorkerSpec[] = [];
  const workerModulesInfo: Array<{
    name: string;
    modules: Array<{ kind: CollectedModule["kind"]; relPath: string; importPath: string }>;
  }> = [];

  for (const [workerIndex, worker] of workers.entries()) {
    const config = getInlineConfig(worker.input);
    const vars: Record<string, unknown> = {
      ...(config.vars ?? {}),
      ...("vars" in worker.input && worker.input.vars ? (worker.input.vars as Record<string, unknown>) : {}),
      ...("secrets" in worker.input && worker.input.secrets ? (worker.input.secrets as Record<string, unknown>) : {}),
    };
    const bindings: Record<string, FencedBindingDescriptor> = {};

    for (const d1 of config.d1_databases ?? []) {
      const entry = getOrAdd(d1ById, d1.database_id, (i) => ({ sup: `D1_${i}`, config: d1 }));
      bindings[d1.binding] = { kind: "d1", sup: entry.sup };
    }
    for (const kv of config.kv_namespaces ?? []) {
      const entry = getOrAdd(kvById, kv.id, (i) => ({ sup: `KV_${i}`, config: kv }));
      bindings[kv.binding] = { kind: "kv", sup: entry.sup };
    }
    for (const r2 of config.r2_buckets ?? []) {
      const entry = getOrAdd(r2ByBucket, r2.bucket_name, (i) => ({ sup: `R2_${i}`, config: r2 }));
      bindings[r2.binding] = { kind: "r2", sup: entry.sup };
    }
    for (const producer of config.queues?.producers ?? []) {
      const entry = getOrAdd(queueProducerByName, producer.queue, (i) => ({ sup: `Q_${i}`, config: producer }));
      bindings[producer.binding] = { kind: "queue", sup: entry.sup };
    }
    for (const consumer of config.queues?.consumers ?? []) {
      queueConsumers.push({ workerName: worker.name, originalQueue: consumer.queue, config: consumer });
    }
    for (const doBinding of config.durable_objects?.bindings ?? []) {
      const ownerWorker = typeof doBinding.script_name === "string" ? doBinding.script_name : worker.name;
      const key = `${ownerWorker}:${doBinding.class_name}`;
      const entry = getOrAdd(doByTarget, key, (i) => ({
        sup: `DO_${i}`,
        ownerWorker,
        className: doBinding.class_name,
      }));
      bindings[doBinding.name] = { kind: "do", sup: entry.sup };
    }
    for (const rl of config.ratelimits ?? []) {
      const entry = getOrAdd(rateLimitByNs, rl.namespace_id, (i) => ({ sup: `RL_${i}`, config: rl }));
      bindings[rl.name] = { kind: "ratelimit", sup: entry.sup };
    }
    for (const svc of config.services ?? []) {
      bindings[svc.binding] = { kind: "service", target: svc.service };
    }
    for (const email of config.send_email ?? []) {
      const key = JSON.stringify([
        email.destination_address,
        email.allowed_destination_addresses,
        email.allowed_sender_addresses,
      ]);
      const entry = getOrAdd(emailByKey, key, (i) => ({ sup: `EMAIL_${i}`, config: email }));
      bindings[email.name] = { kind: "send_email", sup: entry.sup };
    }
    for (const ae of config.analytics_engine_datasets ?? []) {
      const entry = getOrAdd(aeByDataset, ae.dataset ?? ae.binding, (i) => ({ sup: `AE_${i}`, config: ae }));
      bindings[ae.binding] = { kind: "analytics_engine", sup: entry.sup };
    }
    for (const wf of config.workflows ?? []) {
      const ownerWorker = typeof wf.script_name === "string" ? wf.script_name : worker.name;
      const entry = getOrAdd(workflowByName, wf.name, (i) => ({
        sup: `WF_${i}`,
        config: wf,
        ownerWorker,
        className: wf.class_name,
      }));
      bindings[wf.binding] = { kind: "workflow", sup: entry.sup };
    }
    for (const vec of config.vectorize ?? []) {
      const entry = getOrAdd(vectorizeByIndex, vec.index_name, (i) => ({ sup: `VEC_${i}`, config: vec }));
      bindings[vec.binding] = { kind: "native", sup: entry.sup };
    }
    for (const hd of config.hyperdrive ?? []) {
      const entry = getOrAdd(hyperdriveById, hd.id, (i) => ({ sup: `HD_${i}`, config: hd }));
      bindings[hd.binding] = { kind: "native", sup: entry.sup };
    }
    if (config.images?.binding) {
      usesImages = true;
      bindings[config.images.binding] = { kind: "native", sup: "SHARED_IMAGES" };
    }
    if (config.browser?.binding) {
      usesBrowser = true;
      bindings[config.browser.binding] = { kind: "native", sup: "SHARED_BROWSER" };
    }
    if (config.version_metadata?.binding) {
      usesVersionMetadata = true;
      bindings[config.version_metadata.binding] = { kind: "native", sup: "SHARED_VERSION_METADATA" };
    }
    if (config.assets?.binding) {
      assetsConfig = config.assets;
      bindings[config.assets.binding] = { kind: "native", sup: "SHARED_ASSETS" };
    }

    const baseDir = config.base_dir ?? path.dirname(config.main);
    const mainModule = path.relative(baseDir, config.main).split(path.sep).join("/");
    const spec: FencedWorkerSpec = {
      bindings,
      compatibilityDate: config.compatibility_date ?? slotCompatibilityDate,
      compatibilityFlags: Array.isArray(config.compatibility_flags) ? config.compatibility_flags : [],
      mainModule,
      name: worker.name,
      vars,
    };
    workerSpecs.push(spec);

    // Link built worker modules into cleanupDir/assets/w{i}/ with .btcf-text / .btcf-bin suffixes
    const collected = collectWorkerModules(baseDir, config.rules);
    const linkedModules: Array<{ kind: CollectedModule["kind"]; relPath: string; importPath: string }> = [];
    for (const mod of collected) {
      const isBinary = mod.kind === "wasm" || mod.kind === "data";
      const suffix = isBinary ? ".btcf-bin" : ".btcf-text";
      const destRel = `assets/w${workerIndex}/${mod.relPath}${suffix}`;
      linkOrCopy(mod.sourcePath, path.join(cleanupDir, destRel));
      linkedModules.push({ kind: mod.kind, relPath: mod.relPath, importPath: `./${destRel}` });
    }
    workerModulesInfo.push({ name: worker.name, modules: linkedModules });
  }

  // manifest.js describes each Worker for the supervisors; modules.js holds their code, for the
  // module store alone, so a runtime has one copy of it however many slots it has.
  const importLines: string[] = [];
  const workerBuilderLines: string[] = [];
  const moduleLines: string[] = [];
  let importCounter = 0;

  for (const [index, info] of workerModulesInfo.entries()) {
    const spec = workerSpecs[index]!;
    const entrySource = createDynamicWorkerEntrySource(
      spec,
      Object.fromEntries(
        Object.entries(spec.bindings)
          .filter(([, desc]) => desc.kind === "do")
          .flatMap(([bindingName, desc]) => {
            const entry = Array.from(doByTarget.values()).find(
              (candidate) => candidate.sup === (desc as { sup: string }).sup,
            );
            return entry && entry.ownerWorker === info.name ? [[entry.className, bindingName]] : [];
          }),
      ),
    );
    const moduleEntries: string[] = [
      `"__btcf_entry.js": ${JSON.stringify(entrySource)}`,
      ...Object.entries(runtimeModules).map(
        ([filename, code]) => `${JSON.stringify(`__btcf_runtime/${filename}`)}: ${JSON.stringify(code)}`,
      ),
    ];
    for (const mod of info.modules) {
      const varName = `m_${importCounter++}`;
      importLines.push(`import ${varName} from ${JSON.stringify(mod.importPath)};`);
      if (mod.kind === "wasm") moduleEntries.push(`${JSON.stringify(mod.relPath)}: { wasm: ${varName} }`);
      else if (mod.kind === "data") moduleEntries.push(`${JSON.stringify(mod.relPath)}: { data: ${varName} }`);
      else if (mod.kind === "text") moduleEntries.push(`${JSON.stringify(mod.relPath)}: { text: ${varName} }`);
      else if (mod.kind === "cjs") moduleEntries.push(`${JSON.stringify(mod.relPath)}: { cjs: ${varName} }`);
      else moduleEntries.push(`${JSON.stringify(mod.relPath)}: ${varName}`);
    }
    workerBuilderLines.push(`  ${JSON.stringify(info.name)}: { spec: ${JSON.stringify(spec)} }`);
    moduleLines.push(`  ${JSON.stringify(info.name)}: { ${moduleEntries.join(", ")} }`);
  }

  writeFileSync(
    path.join(cleanupDir, "manifest.js"),
    `export const WORKERS = {\n${workerBuilderLines.join(",\n")}\n};\n`,
  );
  writeFileSync(
    path.join(cleanupDir, "modules.js"),
    `${importLines.join("\n")}\nexport const MODULES = {\n${moduleLines.join(",\n")}\n};\n`,
  );
  writeFileSync(
    path.join(cleanupDir, "module-store.js"),
    `import { WorkerEntrypoint } from "cloudflare:workers";
import { MODULES } from "./modules.js";

// Hands a supervisor a Worker's modules as it loads the Worker for a run, in pieces: an RPC value
// is at most 32 MiB, and a Worker's code, or a Wasm module alone, can be more.
const contentOf = (module) => (typeof module === "string" ? module : Object.values(module)[0]);
const kindOf = (module) => (typeof module === "string" ? undefined : Object.keys(module)[0]);
const sizeOf = (content) => (typeof content === "string" ? content.length : content.byteLength);

export default class ModuleStore extends WorkerEntrypoint {
  describe(workerName) {
    return Object.entries(MODULES[workerName]).map(([name, module]) => ({
      name,
      kind: kindOf(module),
      size: sizeOf(contentOf(module)),
    }));
  }

  piece(workerName, name, start, end) {
    return contentOf(MODULES[workerName][name]).slice(start, end);
  }
}
`,
  );

  // Build Supervisor Worker source
  const d1Bindings = Array.from(d1ById.values()).map((entry) => entry.sup);
  const kvBindings = Array.from(kvById.values()).map((entry) => entry.sup);
  const r2Bindings = Array.from(r2ByBucket.values()).map((entry) => entry.sup);
  const doBindings = Array.from(doByTarget.values()).map((entry) => entry.sup);

  const supervisorMainPath = path.join(cleanupDir, "supervisor.js");
  const supervisorCode = `import { WorkerEntrypoint } from "cloudflare:workers";
import { WORKERS } from "./manifest.js";
import {
  clearD1Database,
  clearKVNamespace,
  clearR2Bucket,
  clearRunCaches,
  clearRunDurableObjects,
  dispatchRunQueue,
  encodeScopedObjectName,
  executeRunCacheOperation,
  executeRunD1Operation,
  executeRunDurableObjectOperation,
  executeRunKVOperation,
  executeRunQueueOperation,
  executeRunR2Operation,
  executeRunRateLimitOperation,
  executeRunWorkflowOperation,
  loadRunWorker,
  RunBindingCapability,
  RunBindingProxy,
  runEnded,
  terminateRunWorkflows,
} from "./runtime/WorkerdRun.js";

export { RunBindingCapability };

const SECRET = ${JSON.stringify(secret)};
const D1_RESET_MODE = ${JSON.stringify(d1ResetMode)};
const D1_BINDINGS = ${JSON.stringify(d1Bindings)};
const KV_BINDINGS = ${JSON.stringify(kvBindings)};
const R2_BINDINGS = ${JSON.stringify(r2Bindings)};
const DO_BINDINGS = ${JSON.stringify(doBindings)};
const WORKFLOW_BINDINGS = ${JSON.stringify(Array.from(workflowByName.values()).map((entry) => entry.sup))};

// A Worker's modules, read from the runtime's module store piece by piece (at most 16 MiB each).
const MODULE_PIECE = 16 * 1024 * 1024;
const readModules = async (store, workerName) => {
  const modules = {};
  for (const { name, kind, size } of await store.describe(workerName)) {
    const pieces = [];
    for (let start = 0; start < Math.max(size, 1); start += MODULE_PIECE)
      pieces.push(await store.piece(workerName, name, start, Math.min(size, start + MODULE_PIECE)));
    let content;
    if (typeof pieces[0] === "string") content = pieces.join("");
    else {
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const piece of pieces) {
        bytes.set(new Uint8Array(piece), offset);
        offset += piece.byteLength;
      }
      content = bytes.buffer;
    }
    modules[name] = kind === undefined ? content : { [kind]: content };
  }
  return modules;
};

// Names the vars a run gives a Worker: runs with the same ones share an isolate, so module state
// worked out from them (a client made once from the env) holds for every run that isolate serves.
const varsKey = (vars) => {
  const text = JSON.stringify(Object.entries(vars ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return (hash >>> 0).toString(16) + ":" + text.length;
};

// A Worker's isolate in this slot, which serves the slot's runs with the same vars one after
// another: its env holds only what those runs share, and each call names its run (the entry's
// ctx.props). The loader keeps each Worker it loads by name, so one per slot, Worker and set of
// vars, rather than one per run, keeps the runtime from growing with every run.
const loadDynamicWorker = async (env, ctx, runId, workerName) => {
  const entry = WORKERS[workerName];
  if (!entry) throw new Error("Unknown fenced worker: " + workerName);
  const vars = await env.SLOT_PROXY.getByName("slot").getRuntimeVars(workerName);
  const worker = loadRunWorker(env.LOADER, "vars:" + varsKey(vars), workerName, async () => {
    const proxy = env.SLOT_PROXY.getByName("slot");
    const loaderEnv = {
      ...entry.spec.vars,
      __BTCF_CAPABILITY: ctx.exports.RunBindingCapability({ props: { proxy } }),
    };
    for (const [bindingName, desc] of Object.entries(entry.spec.bindings)) {
      if (desc.kind === "service") {
        loaderEnv["__BTCF_SVC_" + bindingName] = ctx.exports.RunServiceFetcher({ props: { targetWorker: desc.target } });
      } else if (desc.kind === "do") {
        loaderEnv["__BTCF_DO_FETCH_" + bindingName] = ctx.exports.RunDoFetcher({ props: { supBinding: desc.sup } });
      } else if (desc.kind === "native") {
        loaderEnv[desc.sup] = env[desc.sup];
      }
    }
    return {
      compatibilityDate: entry.spec.compatibilityDate,
      // The entry follows each call's run with AsyncLocalStorage, which nodejs_als alone gives.
      compatibilityFlags: entry.spec.compatibilityFlags.some((flag) => flag === "nodejs_compat" || flag === "nodejs_als")
        ? entry.spec.compatibilityFlags
        : [...entry.spec.compatibilityFlags, "nodejs_als"],
      mainModule: "__btcf_entry.js",
      modules: await readModules(env.__BTCF_MODULE_STORE, workerName),
      env: loaderEnv,
    };
  });
  return { getEntrypoint: () => worker.getEntrypoint(undefined, { props: { runId } }) };
};

// The run a request between the slot's Workers is for, which the calling Worker's entry names.
const takeRunHeader = (request) => {
  const runId = request.headers.get("x-btcf-run");
  const headers = new Headers(request.headers);
  headers.delete("x-btcf-run");
  return { runId, request: new Request(request, { headers }) };
};

export class RunServiceFetcher extends WorkerEntrypoint {
  // An RPC method of the target Worker's entrypoint, as the calling run.
  async __btcf_call(runId, method, args) {
    const proxy = this.env.SLOT_PROXY.getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    const worker = await loadDynamicWorker(this.env, this.ctx, runId, this.ctx.props.targetWorker);
    return worker.getEntrypoint().__btcf_call(method, args);
  }

  async fetch(incoming) {
    const { targetWorker } = this.ctx.props;
    const { runId, request } = takeRunHeader(incoming);
    const proxy = this.env.SLOT_PROXY.getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    const worker = await loadDynamicWorker(this.env, this.ctx, runId, targetWorker);
    return worker.getEntrypoint().fetch(request);
  }
}

export class RunDoFetcher extends WorkerEntrypoint {
  async fetch(incoming) {
    const { supBinding } = this.ctx.props;
    const { runId, request } = takeRunHeader(incoming);
    const proxy = this.env.SLOT_PROXY.getByName("slot");
    if (!(await proxy.isActive(runId))) return new Response(runEnded, { status: 410 });
    const rawTarget = request.headers.get("x-btcf-do-target");
    const target = JSON.parse(rawTarget);
    const namespace = this.env[supBinding];
    const nativeId =
      target.kind === "hex"
        ? namespace.idFromString(target.hex)
        : namespace.idFromName(encodeScopedObjectName(runId, target));
    await proxy.recordTouchedDo(supBinding, nativeId.toString());
    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete("x-btcf-do-target");
    return namespace.get(nativeId).fetch(new Request(request, { headers: cleanHeaders }));
  }
}

export class SlotBindingProxy extends RunBindingProxy {
  #cachedUrls = new Map();
  #touchedDos = new Map();
  #createdWorkflows = new Map();
  #runtimeVarsByWorker = {};
  #consumeQueues = true;

  async activateWithVars(runId, runtimeVarsByWorker, settings) {
    await this.activate(runId);
    this.#settle(runtimeVarsByWorker, settings);
  }

  // A run's own vars and settings, given when it takes its slot: an in-process slot is activated
  // ahead of the run that takes it, which may be any of its harness's variants.
  configure(runId, runtimeVarsByWorker, settings) {
    if (!this.isActive(runId)) throw new Error(runEnded);
    this.#settle(runtimeVarsByWorker, settings);
  }

  #settle(runtimeVarsByWorker, settings) {
    this.#runtimeVarsByWorker = runtimeVarsByWorker ?? {};
    this.#consumeQueues = settings?.consumeQueues ?? true;
  }

  /** Whether the run's queue messages go to their consumer, the Worker named. */
  consumesQueues(runId, workerName) {
    if (!this.isActive(runId)) return false;
    const consume = this.#consumeQueues;
    return typeof consume === "boolean" ? consume : (consume[workerName] ?? true);
  }

  getRuntimeVars(workerName) {
    return this.#runtimeVarsByWorker[workerName];
  }

  recordCreatedWorkflow(bindingName, scopedId) {
    let ids = this.#createdWorkflows.get(bindingName);
    if (!ids) this.#createdWorkflows.set(bindingName, (ids = new Set()));
    ids.add(scopedId);
  }

  recordTouchedDo(bindingName, hex) {
    let ids = this.#touchedDos.get(bindingName);
    if (!ids) this.#touchedDos.set(bindingName, (ids = new Set()));
    ids.add(hex);
  }

  async resetBindings(retiredRunId) {
    if (!retiredRunId) return;
    const doMap = Object.fromEntries(DO_BINDINGS.map((name) => [name, this.env[name]]));
    await Promise.all([
      ...D1_BINDINGS.map((name) => clearD1Database(this.env[name], D1_RESET_MODE)),
      ...KV_BINDINGS.map((name) => clearKVNamespace(this.env[name])),
      ...R2_BINDINGS.map((name) => clearR2Bucket(this.env[name])),
      clearRunCaches(caches, retiredRunId, this.#cachedUrls),
      clearRunDurableObjects(doMap, this.#touchedDos),
      terminateRunWorkflows(
        Object.fromEntries(WORKFLOW_BINDINGS.map((name) => [name, this.env[name]])),
        this.#createdWorkflows,
      ),
    ]);
  }

  async perform({ name, args }, runId) {
    const op = args[0];
    if (name === "cache") {
      return executeRunCacheOperation(caches, runId, op, (cacheName, url) => {
        let urls = this.#cachedUrls.get(cacheName);
        if (!urls) this.#cachedUrls.set(cacheName, (urls = new Set()));
        urls.add(url);
      });
    }
    const colon = name.indexOf(":");
    const kind = name.slice(0, colon);
    const target = name.slice(colon + 1);
    if (kind === "d1") return executeRunD1Operation(this.env[target], op);
    if (kind === "kv") return executeRunKVOperation(this.env[target], op);
    if (kind === "r2") return executeRunR2Operation(this.env[target], op);
    if (kind === "queue") return executeRunQueueOperation(this.env[target], runId, op);
    if (kind === "do") {
      return executeRunDurableObjectOperation(this.env[target], runId, op, (hex) => {
        let ids = this.#touchedDos.get(target);
        if (!ids) this.#touchedDos.set(target, (ids = new Set()));
        ids.add(hex);
      });
    }
    if (kind === "ratelimit") return executeRunRateLimitOperation(this.env[target], runId, op);
    if (kind === "workflow") {
      return executeRunWorkflowOperation(this.env[target], runId, op, (scopedId) =>
        this.recordCreatedWorkflow(target, scopedId),
      );
    }
    if (kind === "email") return this.env[target].send(op);
    if (kind === "ae") return this.env[target].writeDataPoint(op);
    if (kind === "service") {
      const worker = await loadDynamicWorker(this.env, this.ctx, runId, target);
      return worker.getEntrypoint().fetch(op);
    }
    if (kind === "servicecall") {
      const worker = await loadDynamicWorker(this.env, this.ctx, runId, target);
      return worker.getEntrypoint().__btcf_call(op.method, op.args);
    }
    throw new Error("Unknown fenced binding operation: " + name);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.headers.get(${JSON.stringify(BTCF_SECRET_HEADER)}) !== SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    const url = new URL(request.url);
    const proxy = env.SLOT_PROXY.getByName("slot");

    if (url.pathname === "/__btcf/activate") {
      const { runId, runtimeVarsByWorker, settings } = await request.json();
      await proxy.activateWithVars(runId, runtimeVarsByWorker, settings);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__btcf/configure") {
      const { runId, runtimeVarsByWorker, settings } = await request.json();
      await proxy.configure(runId, runtimeVarsByWorker, settings);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__btcf/retire") {
      await proxy.retire();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__btcf/cache") {
      const runId = request.headers.get(${JSON.stringify(BTCF_RUN_ID_HEADER)});
      const metaHeader = request.headers.get(${JSON.stringify(BTCF_META_HEADER)});
      const op = metaHeader !== null ? JSON.parse(decodeURIComponent(metaHeader)) : await request.json();
      const cacheReq = new Request(op.request.url, { method: op.request.method, headers: op.request.headers });
      let cacheOp;
      if (op.method === "put") {
        const bytes = await request.arrayBuffer();
        const status = op.response.status;
        const isNullBody = status === 101 || status === 204 || status === 205 || status === 304;
        const resp = new Response(isNullBody ? null : bytes, {
          status,
          statusText: op.response.statusText,
          headers: op.response.headers,
        });
        cacheOp = { cacheName: op.cacheName, method: "put", request: cacheReq, response: resp };
      } else {
        cacheOp = { cacheName: op.cacheName, method: op.method, request: cacheReq, options: op.options };
      }
      const result = await proxy.invoke(runId, { name: "cache", args: [cacheOp] });
      if (result === undefined) return new Response(null, { status: 204 });
      if (result instanceof Response) {
        const body = await result.arrayBuffer();
        const meta = { status: result.status, statusText: result.statusText, headers: [...result.headers] };
        return new Response(body, {
          status: 200,
          headers: { [${JSON.stringify(BTCF_META_HEADER)}]: encodeURIComponent(JSON.stringify(meta)) },
        });
      }
      return Response.json(result);
    }
    if (url.pathname === "/__btcf/dispatch/scheduled") {
      const runId = request.headers.get(${JSON.stringify(BTCF_RUN_ID_HEADER)});
      const workerName = request.headers.get(${JSON.stringify(BTCF_WORKER_HEADER)});
      if (!(await proxy.isActive(runId))) return new Response(runEnded, { status: 410 });
      const controller = await request.json();
      const worker = await loadDynamicWorker(env, ctx, runId, workerName);
      await worker.getEntrypoint().__btcf_scheduled(controller);
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/__btcf/dispatch/queue") {
      const runId = request.headers.get(${JSON.stringify(BTCF_RUN_ID_HEADER)});
      const workerName = request.headers.get(${JSON.stringify(BTCF_WORKER_HEADER)});
      if (!(await proxy.isActive(runId))) return new Response(runEnded, { status: 410 });
      const payload = await request.json();
      const worker = await loadDynamicWorker(env, ctx, runId, workerName);
      const outcome = await worker.getEntrypoint().__btcf_queue(payload);
      return Response.json(outcome);
    }

    const runId = request.headers.get(${JSON.stringify(BTCF_RUN_ID_HEADER)});
    const workerName = request.headers.get(${JSON.stringify(BTCF_WORKER_HEADER)});
    if (!runId || !workerName) return new Response("Missing fenced dispatch headers", { status: 400 });
    if (!(await proxy.isActive(runId))) return new Response(runEnded, { status: 410 });

    const cleanHeaders = new Headers(request.headers);
    cleanHeaders.delete(${JSON.stringify(BTCF_SECRET_HEADER)});
    cleanHeaders.delete(${JSON.stringify(BTCF_RUN_ID_HEADER)});
    cleanHeaders.delete(${JSON.stringify(BTCF_WORKER_HEADER)});
    const origin = cleanHeaders.get(${JSON.stringify(BTCF_ORIGIN_HEADER)});
    if (origin !== null) {
      cleanHeaders.delete(${JSON.stringify(BTCF_ORIGIN_HEADER)});
      cleanHeaders.set("Origin", origin);
    }
    const cleanRequest = new Request(request, { headers: cleanHeaders });
    const worker = await loadDynamicWorker(env, ctx, runId, workerName);
    const response = await worker.getEntrypoint().fetch(cleanRequest);
    const contentLength = response.headers.get("content-length");
    if (contentLength !== null && response.body && /^\\d+$/.test(contentLength)) {
      const fixed = new FixedLengthStream(Number(contentLength));
      void response.body.pipeTo(fixed.writable).catch(() => {});
      return new Response(fixed.readable, response);
    }
    return response;
  },

  async queue(batch, env, ctx) {
    const consumerMap = JSON.parse(env.__BTCF_QUEUE_CONSUMERS || "{}");
    const target = consumerMap[batch.queue];
    if (!target) {
      batch.ackAll();
      return;
    }
    const proxy = env.SLOT_PROXY.getByName("slot");
    await dispatchRunQueue(
      batch,
      (runId) => proxy.isActive(runId),
      async (runId, scopedBatch) => {
        // A run that doesn't consume its queues has no consumer: its messages go nowhere.
        if (!(await proxy.consumesQueues(runId, target.workerName))) {
          for (const message of scopedBatch.messages) message.ack();
          return;
        }
        const worker = await loadDynamicWorker(env, ctx, runId, target.workerName);
        const outcome = await worker.getEntrypoint().__btcf_queue({
          queue: target.originalQueue,
          metadata: scopedBatch.metadata,
          messages: scopedBatch.messages.map((m) => ({
            id: m.id,
            timestamp: m.timestamp.getTime(),
            attempts: m.attempts,
            body: m.body,
          })),
        });
        const acked = new Set(outcome.acked);
        const retried = new Map(outcome.retried);
        for (const message of scopedBatch.messages) {
          if (retried.has(message.id)) {
            const opts = retried.get(message.id);
            message.retry(opts ?? undefined);
          } else if (acked.has(message.id) || outcome.retried.length === 0) {
            message.ack();
          }
        }
      },
    );
  },
};
`;
  writeFileSync(supervisorMainPath, supervisorCode);

  const ownedDoClasses = collectOwnedDoClasses(workers);
  const doHostWrappers = new Map<string, { wrapperPath: string; runtimeFiles: string[] }>();
  const ownedWorkflowClasses = new Map<string, string[]>();
  for (const entry of workflowByName.values()) {
    ownedWorkflowClasses.set(entry.ownerWorker, [
      ...(ownedWorkflowClasses.get(entry.ownerWorker) ?? []),
      entry.className,
    ]);
  }
  for (const [workerIndex, worker] of workers.entries()) {
    const classes = ownedDoClasses.get(worker.name) ?? new Set<string>();
    const workflowClasses = [...new Set(ownedWorkflowClasses.get(worker.name) ?? [])];
    if (classes.size === 0 && workflowClasses.length === 0) continue;
    const config = getInlineConfig(worker.input);
    const baseDir = config.base_dir ?? path.dirname(config.main);
    doHostWrappers.set(
      worker.name,
      writeDoHostWrapper({
        baseDir,
        classes: Array.from(classes).filter((className) => !workflowClasses.includes(className)),
        main: config.main,
        secret,
        slotCount,
        spec: workerSpecs[workerIndex]!,
        workerName: worker.name,
        workflowClasses,
        exportedDoBindings: Object.fromEntries(
          Array.from(doByTarget.values())
            .filter((entry) => entry.ownerWorker === worker.name)
            .map((entry) => [entry.className, entry.sup]),
        ),
      }),
    );
  }

  const maxCompatibilityDate =
    [slotCompatibilityDate, ...workerSpecs.map((spec) => spec.compatibilityDate)].sort().at(-1) ??
    slotCompatibilityDate;

  const slotSupervisorNames: string[] = [];
  const inputs: WorkerInput[] = [];

  for (let slot = 0; slot < slotCount; slot += 1) {
    const supervisorName = getSupervisorName(slot);
    slotSupervisorNames.push(supervisorName);

    const slotQueueConsumers: Record<string, { workerName: string; originalQueue: string }> = {};
    const supervisorConsumerConfigs = queueConsumers.map((consumer) => {
      const slotQueue = appendSlot(consumer.originalQueue, slot);
      slotQueueConsumers[slotQueue] = { workerName: consumer.workerName, originalQueue: consumer.originalQueue };
      return {
        ...consumer.config,
        queue: slotQueue,
        ...(typeof consumer.config.dead_letter_queue === "string"
          ? { dead_letter_queue: appendSlot(consumer.config.dead_letter_queue, slot) }
          : {}),
      };
    });

    const supervisorConfig: Record<string, any> = {
      name: supervisorName,
      main: supervisorMainPath,
      base_dir: cleanupDir,
      no_bundle: true,
      find_additional_modules: true,
      compatibility_date: maxCompatibilityDate,
      compatibility_flags: ["nodejs_compat"],
      worker_loaders: [{ binding: "LOADER" }],
      vars: {
        __BTCF_QUEUE_CONSUMERS: JSON.stringify(slotQueueConsumers),
      },
      rules: [{ type: "ESModule", globs: ["supervisor.js", "manifest.js", "runtime/**/*.js"], fallthrough: false }],
      services: [{ binding: "__BTCF_MODULE_STORE", service: MODULE_STORE_NAME }],
      durable_objects: {
        bindings: [
          { name: "SLOT_PROXY", class_name: "SlotBindingProxy" },
          ...Array.from(doByTarget.values()).map((entry) => ({
            name: entry.sup,
            class_name: getSlotClassName(entry.className, slot),
            script_name: getDoHostName(entry.ownerWorker),
          })),
        ],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["SlotBindingProxy"] }],
      ...(d1ById.size > 0
        ? {
            d1_databases: Array.from(d1ById.values()).map((entry) => ({
              ...entry.config,
              binding: entry.sup,
              database_id: appendSlot(entry.config.database_id, slot),
              ...(typeof entry.config.database_name === "string"
                ? { database_name: appendSlot(entry.config.database_name, slot) }
                : {}),
              ...(typeof entry.config.preview_database_id === "string"
                ? { preview_database_id: appendSlot(entry.config.preview_database_id, slot) }
                : {}),
            })),
          }
        : {}),
      ...(kvById.size > 0
        ? {
            kv_namespaces: Array.from(kvById.values()).map((entry) => ({
              ...entry.config,
              binding: entry.sup,
              id: appendSlot(entry.config.id, slot),
              ...(typeof entry.config.preview_id === "string"
                ? { preview_id: appendSlot(entry.config.preview_id, slot) }
                : {}),
            })),
          }
        : {}),
      ...(r2ByBucket.size > 0
        ? {
            r2_buckets: Array.from(r2ByBucket.values()).map((entry) => ({
              ...entry.config,
              binding: entry.sup,
              bucket_name: appendSlot(entry.config.bucket_name, slot),
              ...(typeof entry.config.preview_bucket_name === "string"
                ? { preview_bucket_name: appendSlot(entry.config.preview_bucket_name, slot) }
                : {}),
            })),
          }
        : {}),
      ...(queueProducerByName.size > 0 || supervisorConsumerConfigs.length > 0
        ? {
            queues: {
              ...(queueProducerByName.size > 0
                ? {
                    producers: Array.from(queueProducerByName.values()).map((entry) => ({
                      ...entry.config,
                      binding: entry.sup,
                      queue: appendSlot(entry.config.queue, slot),
                    })),
                  }
                : {}),
              ...(supervisorConsumerConfigs.length > 0 ? { consumers: supervisorConsumerConfigs } : {}),
            },
          }
        : {}),
      ...(rateLimitByNs.size > 0
        ? {
            ratelimits: Array.from(rateLimitByNs.values()).map((entry) => ({
              ...entry.config,
              name: entry.sup,
              namespace_id: `${entry.config.namespace_id}${slot}`,
            })),
          }
        : {}),
      ...(emailByKey.size > 0
        ? {
            send_email: Array.from(emailByKey.values()).map((entry) => ({
              ...entry.config,
              name: entry.sup,
            })),
          }
        : {}),
      ...(aeByDataset.size > 0
        ? {
            analytics_engine_datasets: Array.from(aeByDataset.values()).map((entry) => ({
              ...entry.config,
              binding: entry.sup,
            })),
          }
        : {}),
      ...(hyperdriveById.size > 0
        ? {
            hyperdrive: Array.from(hyperdriveById.values()).map((entry) => ({
              ...entry.config,
              binding: entry.sup,
            })),
          }
        : {}),
      ...(vectorizeByIndex.size > 0
        ? {
            vectorize: Array.from(vectorizeByIndex.values()).map((entry) => ({ ...entry.config, binding: entry.sup })),
          }
        : {}),
      // The slot's copy of each Workflow, defined by the host Worker that runs its class.
      ...(workflowByName.size > 0
        ? {
            workflows: Array.from(workflowByName.values()).map((entry) => ({
              binding: entry.sup,
              name: appendSlot(entry.config.name, slot),
              class_name: getSlotClassName(entry.className, slot),
              script_name: getDoHostName(entry.ownerWorker),
            })),
          }
        : {}),
      ...(usesImages ? { images: { binding: "SHARED_IMAGES" } } : {}),
      ...(usesBrowser ? { browser: { binding: "SHARED_BROWSER" } } : {}),
      ...(usesVersionMetadata ? { version_metadata: { binding: "SHARED_VERSION_METADATA" } } : {}),
      ...(assetsConfig ? { assets: { ...assetsConfig, binding: "SHARED_ASSETS" } } : {}),
    };

    inputs.push({ config: supervisorConfig } as InlineWorkerInput);
  }

  // A migration of the Worker's classes, as one of each slot's copy of them.
  const slotMigration = (migration: Record<string, any>) => {
    const perSlot = (classes: string[] | undefined) =>
      classes?.flatMap((className) =>
        Array.from({ length: slotCount }, (_, slot) => getSlotClassName(className, slot)),
      );
    const slotEach = <T>(entries: T[] | undefined, map: (entry: T, slot: number) => T) =>
      entries?.flatMap((entry) => Array.from({ length: slotCount }, (_, slot) => map(entry, slot)));
    return {
      ...migration,
      ...(migration.new_classes ? { new_classes: perSlot(migration.new_classes) } : {}),
      ...(migration.new_sqlite_classes ? { new_sqlite_classes: perSlot(migration.new_sqlite_classes) } : {}),
      ...(migration.deleted_classes ? { deleted_classes: perSlot(migration.deleted_classes) } : {}),
      ...(migration.renamed_classes
        ? {
            renamed_classes: slotEach(migration.renamed_classes, (rename: { from: string; to: string }, slot) => ({
              from: getSlotClassName(rename.from, slot),
              to: getSlotClassName(rename.to, slot),
            })),
          }
        : {}),
      ...(migration.transferred_classes
        ? {
            transferred_classes: slotEach(migration.transferred_classes, (transfer: Record<string, any>, slot) => ({
              ...transfer,
              from: getSlotClassName(transfer.from, slot),
              to: getSlotClassName(transfer.to, slot),
              ...(typeof transfer.from_script === "string" && doHostWrappers.has(transfer.from_script)
                ? { from_script: getDoHostName(transfer.from_script) }
                : {}),
            })),
          }
        : {}),
    };
  };

  // One host per Worker with Durable Objects or Workflows, holding each slot's copy of its classes:
  // its code compiles once in the runtime, however many slots there are.
  for (const worker of workers) {
    const hostInfo = doHostWrappers.get(worker.name);
    if (!hostInfo) continue;
    const origConfig = getInlineConfig(worker.input);
    const doHostName = getDoHostName(worker.name);
    const flags = new Set<string>(Array.isArray(origConfig.compatibility_flags) ? origConfig.compatibility_flags : []);
    flags.add("nodejs_compat");

    const workerSpec = workerSpecs[workers.indexOf(worker)]!;
    const doHostConfig: Record<string, any> = {
      name: doHostName,
      main: hostInfo.wrapperPath,
      base_dir: origConfig.base_dir ?? path.dirname(origConfig.main),
      no_bundle: true,
      find_additional_modules: true,
      compatibility_date: origConfig.compatibility_date ?? maxCompatibilityDate,
      compatibility_flags: Array.from(flags),
      ...(Object.keys(workerSpec.vars).length > 0 ? { vars: workerSpec.vars } : {}),
      rules: [
        {
          type: "ESModule",
          globs: [path.basename(origConfig.main), path.basename(hostInfo.wrapperPath), ...hostInfo.runtimeFiles],
          fallthrough: true,
        },
        ...(origConfig.rules ?? []),
      ],
      durable_objects: {
        bindings: Array.from({ length: slotCount }, (_, slot) => ({
          name: `__BTCF_SLOT_PROXY_${slot}`,
          class_name: "SlotBindingProxy",
          script_name: getSupervisorName(slot),
        })),
      },
      // The Worker's migrations, for each slot's copy of its classes.
      ...(origConfig.migrations ? { migrations: origConfig.migrations.map(slotMigration) } : {}),
      ...(origConfig.images?.binding ? { images: { binding: "SHARED_IMAGES" } } : {}),
      ...(origConfig.browser?.binding ? { browser: { binding: "SHARED_BROWSER" } } : {}),
      ...(origConfig.version_metadata?.binding ? { version_metadata: { binding: "SHARED_VERSION_METADATA" } } : {}),
      ...(origConfig.assets?.binding ? { assets: { ...origConfig.assets, binding: "SHARED_ASSETS" } } : {}),
      ...(origConfig.hyperdrive?.length
        ? {
            hyperdrive: origConfig.hyperdrive.map((hd: Record<string, any>) => ({
              ...hd,
              binding: hyperdriveById.get(hd.id)!.sup,
            })),
          }
        : {}),
      ...(origConfig.vectorize?.length
        ? {
            vectorize: origConfig.vectorize.map((vec: Record<string, any>) => ({
              ...vec,
              binding: vectorizeByIndex.get(vec.index_name)!.sup,
            })),
          }
        : {}),
      // Each slot's copy of each Workflow whose class this Worker owns.
      ...(Array.from(workflowByName.values()).some((entry) => entry.ownerWorker === worker.name)
        ? {
            workflows: Array.from({ length: slotCount }, (_, slot) =>
              Array.from(workflowByName.values())
                .filter((entry) => entry.ownerWorker === worker.name)
                .map(({ config: { script_name: _owner, ...definition }, className, sup }) => ({
                  ...definition,
                  // The host doesn't use these bindings, but each needs a name of its own.
                  binding: `${sup}_SLOT${slot}`,
                  name: appendSlot(definition.name, slot),
                  class_name: getSlotClassName(className, slot),
                })),
            ).flat(),
          }
        : {}),
    };

    inputs.push({ config: doHostConfig } as InlineWorkerInput);
  }

  inputs.push({
    config: {
      name: MODULE_STORE_NAME,
      main: path.join(cleanupDir, "module-store.js"),
      base_dir: cleanupDir,
      no_bundle: true,
      find_additional_modules: true,
      compatibility_date: maxCompatibilityDate,
      rules: [
        { type: "ESModule", globs: ["module-store.js", "modules.js"], fallthrough: false },
        { type: "Text", globs: ["**/*.btcf-text"], fallthrough: false },
        { type: "Data", globs: ["**/*.btcf-bin"], fallthrough: false },
      ],
    },
  } as InlineWorkerInput);

  return { cleanupDir, inputs, secret, slotSupervisorNames, workerSpecs };
};

export const cleanupFencedWorkerSlots = (cleanupDir: string | undefined) => {
  if (!cleanupDir) return;
  rmSync(cleanupDir, { force: true, recursive: true });
};
