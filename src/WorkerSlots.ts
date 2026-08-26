import crypto from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { TestHarnessOptions } from "wrangler";
import { unstable_convertConfigBindingsToStartWorkerBindings } from "wrangler";
import { WORKER_CACHE_BRIDGE_PATH, WORKER_CACHE_BRIDGE_SECRET_HEADER } from "./CacheBridge";

type WorkerInput = TestHarnessOptions["workers"][number];
type InlineWorkerInput = Extract<WorkerInput, { config: unknown }>;

const getInlineConfig = (input: WorkerInput) => {
  if (!("config" in input)) {
    throw new Error("Isolated Worker slots require prepared inline Worker configuration");
  }
  return input.config as Record<string, any>;
};

const isSupportedSlotBinding = (binding: { [key: string]: unknown; type: string }, workerNames: Set<string>) => {
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
  return binding.type === "images" || binding.type === "json" || binding.type === "plain_text";
};

export const canUseIsolatedWorkerSlots = (workers: Array<{ input: WorkerInput; name: string }>) => {
  const workerNames = new Set(workers.map((worker) => worker.name));
  try {
    return workers.every(({ input }) => {
      const bindings = unstable_convertConfigBindingsToStartWorkerBindings(getInlineConfig(input));
      return Object.values(bindings).every((binding) =>
        isSupportedSlotBinding(binding as { [key: string]: unknown; type: string }, workerNames),
      );
    });
  } catch {
    return false;
  }
};

const appendSlot = (value: string | undefined, slot: number) =>
  value === undefined ? undefined : `${value}--btcf-slot-${slot}`;

const appendSlotProperty = (binding: Record<string, any>, property: string, slot: number) => {
  const value = binding[property];
  return typeof value === "string" ? { [property]: appendSlot(value, slot) } : {};
};

const getSlotWorkerName = (workerName: string, slot: number) => {
  const suffix = `--btcf-slot-${slot}`;
  return `${workerName.slice(0, Math.max(1, 63 - suffix.length))}${suffix}`;
};

const createCacheNamespaceModule = (main: string, workerName: string, secret: string, namespace: string) => {
  const modulePath = path.join(path.dirname(main), `${workerName}.${secret}.cache-namespace.js`);
  writeFileSync(
    modulePath,
    `const originalCaches = globalThis.caches;
const namespace = ${JSON.stringify(namespace)};

const namespaceRequest = (input) => {
  const request = input instanceof Request ? input : new Request(input);
  const url = new URL(request.url);
  url.searchParams.set("__bun_test_cloudflare_slot", namespace);
  return new Request(url, request);
};

const wrapCache = (cache) => ({
  delete: (request, options) => cache.delete(namespaceRequest(request), options),
  match: (request, options) => cache.match(namespaceRequest(request), options),
  put: (request, response) => cache.put(namespaceRequest(request), response),
});

const namespacedCaches = {
  default: wrapCache(originalCaches.default),
  open: async (cacheName) => wrapCache(await originalCaches.open(namespace + ":" + cacheName)),
};

Object.defineProperty(globalThis, "caches", {
  configurable: true,
  value: namespacedCaches,
});
`,
  );
  return modulePath;
};

const createCacheBridgeWrapper = (main: string, workerName: string, secret: string, namespace: string) => {
  const cacheNamespaceModule = createCacheNamespaceModule(main, workerName, secret, namespace);
  const wrapperPath = path.join(path.dirname(main), `${workerName}.${secret}.cache-bridge.js`);
  const mainSpecifier = `./${path.basename(main)}`;
  const cacheNamespaceSpecifier = `./${path.basename(cacheNamespaceModule)}`;
  writeFileSync(
    wrapperPath,
    `import ${JSON.stringify(cacheNamespaceSpecifier)};
import workerDefault from ${JSON.stringify(mainSpecifier)};
export * from ${JSON.stringify(mainSpecifier)};

const bridgePath = ${JSON.stringify(WORKER_CACHE_BRIDGE_PATH)};
const secretHeader = ${JSON.stringify(WORKER_CACHE_BRIDGE_SECRET_HEADER)};
const bridgeSecret = ${JSON.stringify(secret)};

const deserializeRequest = ({ headers, method, url }) => new Request(url, { headers, method });

const getCache = (cacheName) => cacheName === undefined ? caches.default : caches.open(cacheName);

const handleCacheBridge = async (request) => {
  const form = await request.formData();
  const rawMetadata = form.get("metadata");
  if (typeof rawMetadata !== "string") return new Response("Missing cache metadata", { status: 400 });
  const metadata = JSON.parse(rawMetadata);
  const cache = await getCache(metadata.cacheName);
  const cacheRequest = deserializeRequest(metadata.request);
  const result = new FormData();

  if (metadata.operation === "delete") {
    result.set("metadata", JSON.stringify({ deleted: await cache.delete(cacheRequest, metadata.options) }));
  } else if (metadata.operation === "match") {
    const response = await cache.match(cacheRequest, metadata.options);
    result.set("metadata", JSON.stringify({ response: response ? {
      headers: [...response.headers],
      status: response.status,
      statusText: response.statusText,
    } : undefined }));
    if (response) result.set("body", await response.blob(), "body");
  } else if (metadata.operation === "put") {
    const body = form.get("body");
    await cache.put(cacheRequest, new Response(body instanceof Blob ? body : null, metadata.response));
    result.set("metadata", "{}");
  } else {
    return new Response("Unknown cache operation", { status: 400 });
  }

  return new Response(result);
};

const maybeHandleCacheBridge = (request) => {
  const url = new URL(request.url);
  if (url.pathname !== bridgePath || request.headers.get(secretHeader) !== bridgeSecret) return;
  return handleCacheBridge(request);
};

const wrappedDefault = typeof workerDefault === "function"
  ? class BunTestCloudflareWorkerSlot extends workerDefault {
      fetch(request, ...args) {
        return maybeHandleCacheBridge(request) ?? super.fetch(request, ...args);
      }
    }
  : {
      ...workerDefault,
      fetch(request, ...args) {
        return maybeHandleCacheBridge(request) ?? workerDefault.fetch.call(this, request, ...args);
      },
    };

export default wrappedDefault;
`,
  );
  return wrapperPath;
};

const getSlotModuleRule = (main: string, cacheNamespaceModule: string) => ({
  fallthrough: true,
  globs: [path.basename(main), path.basename(cacheNamespaceModule)],
  type: "ESModule",
});

const createSlotInput = (
  input: WorkerInput,
  workerName: string,
  slot: number,
  secret: string,
  slotWorkerNames: Map<string, string>,
): WorkerInput => {
  const config = getInlineConfig(input);
  const slotWorkerName = getSlotWorkerName(workerName, slot);
  const main = createCacheBridgeWrapper(config.main, slotWorkerName, secret, `${secret}:slot-${slot}`);
  const cacheNamespaceModule = main.replace(/\.cache-bridge\.js$/, ".cache-namespace.js");
  return {
    ...input,
    config: {
      ...config,
      d1_databases: config.d1_databases?.map((binding: Record<string, any>) => ({
        ...binding,
        ...appendSlotProperty(binding, "database_id", slot),
        ...appendSlotProperty(binding, "database_name", slot),
        ...appendSlotProperty(binding, "preview_database_id", slot),
      })),
      durable_objects: config.durable_objects
        ? {
            ...config.durable_objects,
            bindings: config.durable_objects.bindings?.map((binding: Record<string, any>) => ({
              ...binding,
              ...(typeof binding.script_name === "string" && slotWorkerNames.has(binding.script_name)
                ? { script_name: slotWorkerNames.get(binding.script_name) }
                : {}),
            })),
          }
        : undefined,
      kv_namespaces: config.kv_namespaces?.map((binding: Record<string, any>) => ({
        ...binding,
        ...appendSlotProperty(binding, "id", slot),
        ...appendSlotProperty(binding, "preview_id", slot),
      })),
      main,
      name: slotWorkerName,
      r2_buckets: config.r2_buckets?.map((binding: Record<string, any>) => ({
        ...binding,
        ...appendSlotProperty(binding, "bucket_name", slot),
        ...appendSlotProperty(binding, "preview_bucket_name", slot),
      })),
      rules: [getSlotModuleRule(config.main, cacheNamespaceModule), ...(config.rules ?? [])],
      services: config.services?.map((binding: Record<string, any>) => ({
        ...binding,
        ...(typeof binding.service === "string" && slotWorkerNames.has(binding.service)
          ? { service: slotWorkerNames.get(binding.service) }
          : {}),
      })),
    },
  } as InlineWorkerInput;
};

export const createIsolatedWorkerSlots = (workers: Array<{ input: WorkerInput; name: string }>, slotCount: number) => {
  const secret = crypto.randomUUID();
  const workerNames = workers.map((worker) =>
    Array.from({ length: slotCount }, (_, slot) => getSlotWorkerName(worker.name, slot)),
  );
  const inputs = Array.from({ length: slotCount }, (_, slot) => {
    const slotWorkerNames = new Map(workers.map((worker, index) => [worker.name, workerNames[index]![slot]!]));
    return workers.map((worker) => createSlotInput(worker.input, worker.name, slot, secret, slotWorkerNames));
  }).flat();
  return { inputs, secret, workerNames };
};
