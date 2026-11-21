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
  BTCF_RUN_ID_HEADER,
  BTCF_SECRET_HEADER,
  BTCF_WORKER_HEADER,
  type FencedBindingDescriptor,
  type FencedWorkerSpec,
} from "./FencedEnvBridge";

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
  "browser",
  "hyperdrive",
  "images",
  "json",
  "plain_text",
  "send_email",
  "version_metadata",
]);

/**
 * Wrangler before 4.108 deletes the rate limits of every Worker but its primary one when it merges
 * their Miniflare options, so a rate limit in any slot past the first was undefined.
 */
export const wranglerKeepsSecondaryRateLimits = (wranglerVersion: string) =>
  semver.satisfies(wranglerVersion, ">=4.108.0");

const slotsKeepRateLimits = wranglerKeepsSecondaryRateLimits(
  (require("wrangler/package.json") as { version: string }).version,
);

export const isSupportedSlotBinding = (
  binding: { [key: string]: unknown; type: string },
  workerNames: Set<string>,
): boolean => {
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
  return SHARED_SLOT_BINDINGS.has(binding.type);
};

export const canUseFencedWorkerSlots = (workers: Array<{ input: WorkerInput; name: string }>): boolean => {
  const workerNames = new Set(workers.map((worker) => worker.name));
  try {
    return workers.every(({ input }) => {
      const config = getInlineConfig(input);
      if (Array.isArray(config.containers) && config.containers.length > 0) return false;
      if (Array.isArray(config.workflows) && config.workflows.length > 0) return false;
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

const getDoHostName = (workerName: string, slot: number) => {
  const suffix = `--btcf-do-${slot}`;
  return `${workerName.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
};

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
  main: string;
  secret: string;
  spec: FencedWorkerSpec;
  workerName: string;
}): { wrapperPath: string; runtimeFiles: string[] } => {
  const { baseDir, classes, main, secret, spec, workerName } = options;
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
export class ${className} extends DurableObject {
  #instance;
  #runId;
  #originalName;

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

  #getInstance() {
    if (!this.#instance) {
      const runId = this.#getRunId();
      const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
      const fencedEnv = buildDoFencedEnv(runId, proxy, this.env);
      const OriginalClass = __userModule[${JSON.stringify(className)}];
      if (!OriginalClass) throw new Error("Missing Durable Object export ${className}");
      this.#instance = new OriginalClass(this.ctx, fencedEnv);
    }
    return this.#instance;
  }

  #withCaches(runId, proxy, fn) {
    const storage = createRunCacheStorage((op) => proxy.invoke(runId, { name: "cache", args: [op] }));
    return cachesAls.run(storage, fn);
  }

  async __btcf_rpc(prop, args) {
    const runId = this.#getRunId();
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      return await instance[prop](...args);
    });
  }

  async fetch(request) {
    const runId = this.#getRunId();
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      return await instance.fetch(request);
    });
  }

  async alarm(alarmInfo) {
    const runId = this.#runId;
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.#instance = undefined;
      return;
    }
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      if (typeof instance.alarm === "function") {
        return await instance.alarm(alarmInfo);
      }
    });
  }

  async webSocketMessage(ws, message) {
    const runId = this.#runId;
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      if (typeof instance.webSocketMessage === "function") return await instance.webSocketMessage(ws, message);
    });
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const runId = this.#runId;
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      if (typeof instance.webSocketClose === "function") {
        return await instance.webSocketClose(ws, code, reason, wasClean);
      }
    });
  }

  async webSocketError(ws, error) {
    const runId = this.#runId;
    const proxy = this.env.__BTCF_SLOT_PROXY.getByName("slot");
    if (!runId || !(await proxy.isActive(runId))) return;
    return this.#withCaches(runId, proxy, async () => {
      const instance = this.#getInstance();
      if (typeof instance.webSocketError === "function") return await instance.webSocketError(ws, error);
    });
  }

  async __btcf_destroy() {
    this.#instance = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
`,
    )
    .join("\n");

  const code = `import { DurableObject } from "cloudflare:workers";
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
  parseRunObjectIdentity,
  runEnded,
} from "./btcf-runtime/WorkerdRun.js";

const SPEC = ${JSON.stringify(spec)};
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

const buildDoFencedEnv = (runId, proxy, rawEnv) => {
  const invoke = (name, op) => proxy.invoke(runId, { name, args: [op] });
  const env = { ...SPEC.vars };
  for (const [bindingName, desc] of Object.entries(SPEC.bindings)) {
    if (desc.kind === "d1") env[bindingName] = createRunD1Binding((op) => invoke("d1:" + desc.sup, op));
    else if (desc.kind === "kv") env[bindingName] = createRunKVBinding((op) => invoke("kv:" + desc.sup, op));
    else if (desc.kind === "r2") env[bindingName] = createRunR2Binding((op) => invoke("r2:" + desc.sup, op));
    else if (desc.kind === "queue") env[bindingName] = createRunQueueBinding((op) => invoke("queue:" + desc.sup, op));
    else if (desc.kind === "do") env[bindingName] = createRunDurableObjectNamespace((op) => invoke("do:" + desc.sup, op));
    else if (desc.kind === "ratelimit") env[bindingName] = createRunRateLimitBinding((op) => invoke("ratelimit:" + desc.sup, op));
    else if (desc.kind === "service") {
      env[bindingName] = {
        fetch: (input, init) => {
          const req = input instanceof Request && init === undefined ? input : new Request(input, init);
          return invoke("service:" + desc.target, req);
        },
      };
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

export default { fetch: () => new Response("DO host", { status: 404 }) };
${classDecls}
`;
  writeFileSync(wrapperPath, code);
  return { wrapperPath, runtimeFiles };
};

const createDynamicWorkerEntrySource = (spec: FencedWorkerSpec): string => `
import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createRunCacheStorage,
  createRunD1Binding,
  createRunDurableObjectNamespace,
  createRunKVBinding,
  createRunQueueBinding,
  createRunR2Binding,
  createRunRateLimitBinding,
} from "./__btcf_runtime/WorkerdRun.js";

const SPEC = ${JSON.stringify(spec)};
let cachedEnv;
let cachedUserDefault;

const ensureEnv = (rawEnv) => {
  if (!cachedEnv) {
    const cap = rawEnv.__BTCF_CAPABILITY;
    Object.defineProperty(globalThis, "caches", {
      configurable: true,
      value: createRunCacheStorage((op) => cap.invoke("cache", op)),
    });
    const env = { ...SPEC.vars, ...(rawEnv.__BTCF_RUNTIME_VARS ?? {}) };
    for (const [bindingName, desc] of Object.entries(SPEC.bindings)) {
      if (desc.kind === "d1") env[bindingName] = createRunD1Binding((op) => cap.invoke("d1:" + desc.sup, op));
      else if (desc.kind === "kv") env[bindingName] = createRunKVBinding((op) => cap.invoke("kv:" + desc.sup, op));
      else if (desc.kind === "r2") env[bindingName] = createRunR2Binding((op) => cap.invoke("r2:" + desc.sup, op));
      else if (desc.kind === "queue") env[bindingName] = createRunQueueBinding((op) => cap.invoke("queue:" + desc.sup, op));
      else if (desc.kind === "do") {
        const doFetcher = rawEnv["__BTCF_DO_FETCH_" + bindingName];
        env[bindingName] = createRunDurableObjectNamespace(
          (op) => cap.invoke("do:" + desc.sup, op),
          doFetcher
            ? (target, req) => {
                const headers = new Headers(req.headers);
                headers.set("x-btcf-do-target", JSON.stringify(target));
                return doFetcher.fetch(new Request(req, { headers }));
              }
            : undefined,
        );
      }
      else if (desc.kind === "ratelimit") env[bindingName] = createRunRateLimitBinding((op) => cap.invoke("ratelimit:" + desc.sup, op));
      else if (desc.kind === "service") env[bindingName] = rawEnv["__BTCF_SVC_" + bindingName];
      else if (desc.kind === "send_email") env[bindingName] = { send: (msg) => cap.invoke("email:" + desc.sup, msg) };
      else if (desc.kind === "analytics_engine") {
        env[bindingName] = { writeDataPoint: (event) => { void cap.invoke("ae:" + desc.sup, event).catch(() => {}); } };
      } else if (desc.kind === "native") {
        env[bindingName] = rawEnv[desc.sup];
      }
    }
    cachedEnv = env;
  }
  return cachedEnv;
};

const getUserDefault = async (rawEnv) => {
  ensureEnv(rawEnv);
  if (!cachedUserDefault) {
    const mod = await import(${JSON.stringify(`./${spec.mainModule}`)});
    cachedUserDefault = mod.default;
  }
  return cachedUserDefault;
};

export default class BtcfDynamicEntry extends WorkerEntrypoint {
  async fetch(request) {
    const env = ensureEnv(this.env);
    const worker = await getUserDefault(this.env);
    if (typeof worker === "function") return new worker(this.ctx, env).fetch(request);
    return worker.fetch(request, env, this.ctx);
  }

  async __btcf_queue(payload) {
    const env = ensureEnv(this.env);
    const worker = await getUserDefault(this.env);
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
      await new worker(this.ctx, env).queue(batch);
    } else if (typeof worker.queue === "function") {
      await worker.queue(batch, env, this.ctx);
    }
    return { acked: [...acked], retried: [...retried.entries()] };
  }

  async __btcf_scheduled(controller) {
    const env = ensureEnv(this.env);
    const worker = await getUserDefault(this.env);
    const ctrl = { cron: controller.cron, scheduledTime: controller.scheduledTime, noRetry() {} };
    if (typeof worker === "function") {
      await new worker(this.ctx, env).scheduled(ctrl);
    } else if (typeof worker.scheduled === "function") {
      await worker.scheduled(ctrl, env, this.ctx);
    }
  }
}
`;

export const createFencedWorkerSlots = (
  workers: Array<{ input: WorkerInput; name: string }>,
  slotCount: number,
): FencedWorkerSlots => {
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
      compatibilityDate: config.compatibility_date ?? "2026-09-09",
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

  // Generate shared manifest.js for the Supervisor Workers
  const importLines: string[] = [];
  const workerBuilderLines: string[] = [];
  let importCounter = 0;

  for (const [index, info] of workerModulesInfo.entries()) {
    const spec = workerSpecs[index]!;
    const entrySource = createDynamicWorkerEntrySource(spec);
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
    workerBuilderLines.push(
      `  ${JSON.stringify(info.name)}: { spec: ${JSON.stringify(spec)}, modules: { ${moduleEntries.join(", ")} } }`,
    );
  }

  const manifestPath = path.join(cleanupDir, "manifest.js");
  writeFileSync(
    manifestPath,
    `${importLines.join("\n")}\nexport const WORKERS = {\n${workerBuilderLines.join(",\n")}\n};\n`,
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
  loadRunWorker,
  RunBindingCapability,
  RunBindingProxy,
  runEnded,
} from "./runtime/WorkerdRun.js";

export { RunBindingCapability };

const SECRET = ${JSON.stringify(secret)};
const D1_BINDINGS = ${JSON.stringify(d1Bindings)};
const KV_BINDINGS = ${JSON.stringify(kvBindings)};
const R2_BINDINGS = ${JSON.stringify(r2Bindings)};
const DO_BINDINGS = ${JSON.stringify(doBindings)};

const loadDynamicWorker = async (env, ctx, runId, workerName) => {
  const entry = WORKERS[workerName];
  if (!entry) throw new Error("Unknown fenced worker: " + workerName);
  const proxy = env.SLOT_PROXY.getByName("slot");
  const runtimeVars = await proxy.getRuntimeVars(workerName);
  const capability = ctx.exports.RunBindingCapability({ props: { runId, proxy } });
  const loaderEnv = {
    ...entry.spec.vars,
    ...(runtimeVars ?? {}),
    __BTCF_CAPABILITY: capability,
    ...(runtimeVars ? { __BTCF_RUNTIME_VARS: runtimeVars } : {}),
  };
  for (const [bindingName, desc] of Object.entries(entry.spec.bindings)) {
    if (desc.kind === "service") {
      loaderEnv["__BTCF_SVC_" + bindingName] = ctx.exports.RunServiceFetcher({
        props: { runId, targetWorker: desc.target },
      });
    } else if (desc.kind === "do") {
      loaderEnv["__BTCF_DO_FETCH_" + bindingName] = ctx.exports.RunDoFetcher({
        props: { runId, supBinding: desc.sup },
      });
    } else if (desc.kind === "native") {
      loaderEnv[desc.sup] = env[desc.sup];
    }
  }
  return loadRunWorker(env.LOADER, runId, workerName, () => ({
    compatibilityDate: entry.spec.compatibilityDate,
    compatibilityFlags: entry.spec.compatibilityFlags,
    mainModule: "__btcf_entry.js",
    modules: entry.modules,
    env: loaderEnv,
  }));
};

export class RunServiceFetcher extends WorkerEntrypoint {
  async fetch(request) {
    const { runId, targetWorker } = this.ctx.props;
    const proxy = this.env.SLOT_PROXY.getByName("slot");
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    const worker = await loadDynamicWorker(this.env, this.ctx, runId, targetWorker);
    return worker.getEntrypoint().fetch(request);
  }
}

export class RunDoFetcher extends WorkerEntrypoint {
  async fetch(request) {
    const { runId, supBinding } = this.ctx.props;
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
  #runtimeVarsByWorker = {};

  async activateWithVars(runId, runtimeVarsByWorker) {
    await this.activate(runId);
    this.#runtimeVarsByWorker = runtimeVarsByWorker ?? {};
  }

  getRuntimeVars(workerName) {
    return this.#runtimeVarsByWorker[workerName];
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
      ...D1_BINDINGS.map((name) => clearD1Database(this.env[name])),
      ...KV_BINDINGS.map((name) => clearKVNamespace(this.env[name])),
      ...R2_BINDINGS.map((name) => clearR2Bucket(this.env[name])),
      clearRunCaches(caches, retiredRunId, this.#cachedUrls),
      clearRunDurableObjects(doMap, this.#touchedDos),
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
    if (kind === "email") return this.env[target].send(op);
    if (kind === "ae") return this.env[target].writeDataPoint(op);
    if (kind === "service") {
      const worker = await loadDynamicWorker(this.env, this.ctx, runId, target);
      return worker.getEntrypoint().fetch(op);
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
      const { runId, runtimeVarsByWorker } = await request.json();
      await proxy.activateWithVars(runId, runtimeVarsByWorker);
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
  for (const [workerIndex, worker] of workers.entries()) {
    const classes = ownedDoClasses.get(worker.name);
    if (!classes || classes.size === 0) continue;
    const config = getInlineConfig(worker.input);
    const baseDir = config.base_dir ?? path.dirname(config.main);
    doHostWrappers.set(
      worker.name,
      writeDoHostWrapper({
        baseDir,
        classes: Array.from(classes),
        main: config.main,
        secret,
        spec: workerSpecs[workerIndex]!,
        workerName: worker.name,
      }),
    );
  }

  const minSupervisorCompatibilityDate = "2026-09-09";
  const maxCompatibilityDate =
    [minSupervisorCompatibilityDate, ...workerSpecs.map((spec) => spec.compatibilityDate)].sort().at(-1) ??
    minSupervisorCompatibilityDate;

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
      rules: [
        { type: "ESModule", globs: ["supervisor.js", "manifest.js", "runtime/**/*.js"], fallthrough: true },
        { type: "Text", globs: ["**/*.btcf-text"], fallthrough: false },
        { type: "Data", globs: ["**/*.btcf-bin"], fallthrough: false },
      ],
      durable_objects: {
        bindings: [
          { name: "SLOT_PROXY", class_name: "SlotBindingProxy" },
          ...Array.from(doByTarget.values()).map((entry) => ({
            name: entry.sup,
            class_name: entry.className,
            script_name: getDoHostName(entry.ownerWorker, slot),
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
      ...(usesImages ? { images: { binding: "SHARED_IMAGES" } } : {}),
      ...(usesBrowser ? { browser: { binding: "SHARED_BROWSER" } } : {}),
      ...(usesVersionMetadata ? { version_metadata: { binding: "SHARED_VERSION_METADATA" } } : {}),
      ...(assetsConfig ? { assets: { ...assetsConfig, binding: "SHARED_ASSETS" } } : {}),
    };

    inputs.push({ config: supervisorConfig } as InlineWorkerInput);

    // Emit native DO Host Workers for this slot
    for (const worker of workers) {
      const hostInfo = doHostWrappers.get(worker.name);
      if (!hostInfo) continue;
      const origConfig = getInlineConfig(worker.input);
      const doHostName = getDoHostName(worker.name, slot);
      const flags = new Set<string>(
        Array.isArray(origConfig.compatibility_flags) ? origConfig.compatibility_flags : [],
      );
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
          bindings: [{ name: "__BTCF_SLOT_PROXY", class_name: "SlotBindingProxy", script_name: supervisorName }],
        },
        ...(origConfig.migrations
          ? {
              migrations: origConfig.migrations.map((migration: Record<string, any>) => ({
                ...migration,
                ...(migration.transferred_classes
                  ? {
                      transferred_classes: migration.transferred_classes.map((transfer: Record<string, any>) => ({
                        ...transfer,
                        ...(typeof transfer.from_script === "string" && doHostWrappers.has(transfer.from_script)
                          ? { from_script: getDoHostName(transfer.from_script, slot) }
                          : {}),
                      })),
                    }
                  : {}),
              })),
            }
          : {}),
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
      };

      inputs.push({ config: doHostConfig } as InlineWorkerInput);
    }
  }

  return { cleanupDir, inputs, secret, slotSupervisorNames, workerSpecs };
};

export const cleanupFencedWorkerSlots = (cleanupDir: string | undefined) => {
  if (!cleanupDir) return;
  rmSync(cleanupDir, { force: true, recursive: true });
};
