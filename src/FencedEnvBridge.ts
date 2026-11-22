import type { WorkerHandle } from "wrangler";
import type { RunFence } from "./RunFence";
import { createRunCacheStorage, type RunCacheOperation } from "./WorkerdCache";
import { encodeScopedObjectName } from "./WorkerdDurableObject";
import { runQueueMessage } from "./WorkerdQueue";
import { createRunWorkflowBinding, executeRunWorkflowOperation } from "./WorkerdWorkflow";

export const BTCF_SECRET_HEADER = "x-btcf-secret";
export const BTCF_RUN_ID_HEADER = "x-btcf-run-id";
export const BTCF_WORKER_HEADER = "x-btcf-worker";
export const BTCF_META_HEADER = "x-btcf-meta";
/**
 * A dispatched request's own Origin, which the slot supervisor gives back to it: through Miniflare's
 * platform proxy (a shared slot broker's path), the request's headers are the proxy call's, and its
 * entry refuses an Origin that isn't one of its own hosts ("Invalid Origin header").
 */
export const BTCF_ORIGIN_HEADER = "x-btcf-origin";

export type FencedBindingDescriptor =
  | { kind: "d1"; sup: string }
  | { kind: "kv"; sup: string }
  | { kind: "r2"; sup: string }
  | { kind: "queue"; sup: string }
  | { kind: "do"; sup: string }
  | { kind: "ratelimit"; sup: string }
  | { kind: "service"; target: string }
  | { kind: "send_email"; sup: string }
  | { kind: "analytics_engine"; sup: string }
  | { kind: "workflow"; sup: string }
  | { kind: "native"; sup: string };

export type FencedWorkerSpec = {
  bindings: Record<string, FencedBindingDescriptor>;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  name: string;
  vars: Record<string, unknown>;
};

const unwrappedProxies = new WeakMap<object, unknown>();

const unwrapArg = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(unwrapArg);
  if (value && typeof value === "object") {
    const inner = unwrappedProxies.get(value);
    if (inner !== undefined) return inner;
  }
  return value;
};

/**
 * Wraps a Miniflare ProxyClient binding (D1, KV, R2, etc.) with RunFence so calls from a retired
 * run are rejected and in-flight calls are drained before slot reset, while keeping Miniflare's
 * native sync/async proxy behavior intact.
 */
const fenceNativeBinding = <T extends object>(target: T, fence: RunFence): T => {
  const proxy = new Proxy(target, {
    get(obj, prop, receiver) {
      if (prop === "then" || prop === "catch" || prop === "finally") return undefined;
      fence.assertActive();
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        fence.assertActive();
        const result = Reflect.apply(value, obj, args.map(unwrapArg));
        if (result && typeof (result as PromiseLike<unknown>).then === "function") {
          return fence.dispatch(() => result);
        }
        if (result && typeof result === "object") {
          return fenceNativeBinding(result, fence);
        }
        return result;
      };
    },
  });
  unwrappedProxies.set(proxy, target);
  return proxy;
};

const fenceQueueBinding = (rawQueue: Queue, runId: string, fence: RunFence): Queue => ({
  metrics: () => fence.dispatch(() => rawQueue.metrics()),
  send: (body: unknown, options?: QueueSendOptions) =>
    fence.dispatch(() =>
      rawQueue.send(runQueueMessage(runId, body), {
        ...options,
        contentType: "v8",
      }),
    ),
  sendBatch: (messages: Iterable<MessageSendRequest<unknown>>, options?: QueueSendBatchOptions) =>
    fence.dispatch(() =>
      rawQueue.sendBatch(
        Array.from(messages, (message) => ({
          ...message,
          body: runQueueMessage(runId, message.body),
          contentType: "v8",
        })),
        options,
      ),
    ),
});

const fenceRateLimitBinding = (rawLimiter: RateLimit, runId: string, fence: RunFence): RateLimit => ({
  limit: (options: RateLimitOptions) => fence.dispatch(() => rawLimiter.limit({ key: `${runId}:${options.key}` })),
});

type SlotProxyStub = {
  recordCreatedWorkflow(bindingName: string, scopedId: string): Promise<void>;
  recordTouchedDo(bindingName: string, hex: string): Promise<void>;
};

/** A call's place among its stub's calls in flight: the host starts each train's calls in order. */
type CallOrder = { train: string; seq: number };

const fenceDurableObjectBinding = (
  rawNamespace: DurableObjectNamespace,
  supBinding: string,
  slotProxy: SlotProxyStub | undefined,
  runId: string,
  fence: RunFence,
): DurableObjectNamespace => {
  const recorded = new Set<string>();
  const originalNames = new WeakMap<object, string | undefined>();

  const wrapId = (nativeId: DurableObjectId, originalName: string | undefined): DurableObjectId => {
    originalNames.set(nativeId, originalName);
    const wrapped = new Proxy(nativeId, {
      get(obj, prop, receiver) {
        if (prop === "name") return originalName;
        const value = Reflect.get(obj, prop, receiver);
        return typeof value === "function" ? value.bind(obj) : value;
      },
    });
    unwrappedProxies.set(wrapped, nativeId);
    return wrapped;
  };

  // The runtime delivers the calls an isolate makes to an object in the order they were made, but
  // each goes to the object as a request of its own here, and one can overtake another: the host
  // starts them in order. Counted per object, not per stub, as callers commonly get a stub for
  // each call. A call made with nothing in flight to its object needs no order: a new train.
  const objectCalls = new Map<string, { train: string; seq: number; inFlight: number }>();
  const callsTo = (hex: string) => ({
    next: (): CallOrder => {
      let calls = objectCalls.get(hex);
      if (!calls) objectCalls.set(hex, (calls = { train: "", seq: 0, inFlight: 0 }));
      if (calls.inFlight++ === 0) {
        calls.train = crypto.randomUUID();
        calls.seq = 0;
      } else calls.seq++;
      return { train: calls.train, seq: calls.seq };
    },
    done: () => {
      const calls = objectCalls.get(hex)!;
      if (--calls.inFlight === 0) objectCalls.delete(hex);
    },
  });

  const ensureRecorded = (hex: string) => {
    if (!slotProxy || recorded.has(hex)) return;
    recorded.add(hex);
    void slotProxy.recordTouchedDo(supBinding, hex).catch(() => {});
  };

  const createStub = (id: DurableObjectId): DurableObjectStub => {
    fence.assertActive();
    const nativeId = (unwrappedProxies.get(id) as DurableObjectId | undefined) ?? id;
    const rawStub = rawNamespace.get(nativeId) as unknown as DurableObjectStub & {
      __btcf_rpc(prop: string, args: unknown[], order: CallOrder): Promise<unknown>;
    };
    const hex = nativeId.toString();
    const calls = callsTo(hex);
    const name = originalNames.get(nativeId) ?? id.name;

    return new Proxy({} as DurableObjectStub, {
      get(_unused, property) {
        if (property === "id") return id;
        if (property === "name") return name;
        if (property === "then" || property === "catch" || property === "finally" || typeof property === "symbol") {
          return undefined;
        }
        if (property === "fetch") {
          return (input: RequestInfo | URL, init?: RequestInit) =>
            fence.dispatch(() => {
              ensureRecorded(hex);
              return rawStub.fetch(input as any, init as any);
            });
        }
        // Calls run in the object concurrently, as the runtime's own stubs' do, started in order.
        return (...args: unknown[]) =>
          fence.dispatch(async () => {
            ensureRecorded(hex);
            const order = calls.next();
            try {
              return await rawStub.__btcf_rpc(String(property), args, order);
            } finally {
              calls.done();
            }
          });
      },
    });
  };

  const namespace: DurableObjectNamespace = {
    newUniqueId: () => {
      fence.assertActive();
      return wrapId(
        rawNamespace.idFromName(encodeScopedObjectName(runId, { kind: "unique", token: crypto.randomUUID() })),
        undefined,
      );
    },
    idFromName: (name: string) => {
      fence.assertActive();
      return wrapId(rawNamespace.idFromName(encodeScopedObjectName(runId, { kind: "named", name })), name);
    },
    idFromString: (hex: string) => {
      fence.assertActive();
      return rawNamespace.idFromString(hex);
    },
    get: (id: DurableObjectId) => createStub(id),
    getByName: (name: string) => {
      fence.assertActive();
      const id = wrapId(rawNamespace.idFromName(encodeScopedObjectName(runId, { kind: "named", name })), name);
      return createStub(id);
    },
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace;

  return namespace;
};

export const createFencedBunCacheStorage = (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  fence: RunFence,
): CacheStorage => {
  const invokeCache = (op: RunCacheOperation) =>
    fence.dispatch(async () => {
      const serializedRequest = {
        url: op.request.url,
        method: op.request.method,
        headers: [...op.request.headers],
      };
      const headers: Record<string, string> = {
        [BTCF_SECRET_HEADER]: secret,
        [BTCF_RUN_ID_HEADER]: runId,
      };
      let body: ArrayBuffer | string;
      if (op.method === "put") {
        headers[BTCF_META_HEADER] = encodeURIComponent(
          JSON.stringify({
            cacheName: op.cacheName,
            method: "put",
            request: serializedRequest,
            response: {
              status: op.response.status,
              statusText: op.response.statusText,
              headers: [...op.response.headers],
            },
          }),
        );
        headers["content-type"] = "application/octet-stream";
        body = await op.response.arrayBuffer();
      } else {
        headers["content-type"] = "application/json";
        body = JSON.stringify({
          cacheName: op.cacheName,
          method: op.method,
          request: serializedRequest,
          options: op.options,
        });
      }

      const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/cache", {
        method: "POST",
        headers,
        body: body as any,
      });
      if (response.status === 204) return undefined;
      const metaHeader = response.headers.get(BTCF_META_HEADER);
      if (metaHeader !== null) {
        const meta = JSON.parse(decodeURIComponent(metaHeader)) as {
          headers: [string, string][];
          status: number;
          statusText: string;
        };
        const rawBytes = await response.arrayBuffer();
        const isNullBody = meta.status === 101 || meta.status === 204 || meta.status === 205 || meta.status === 304;
        return new Response(isNullBody ? null : rawBytes, {
          status: meta.status,
          statusText: meta.statusText,
          headers: new Headers(meta.headers),
        });
      }
      if (!response.ok) {
        throw new Error(`Fenced cache bridge failed (${response.status}): ${await response.text()}`);
      }
      return response.json();
    });

  return createRunCacheStorage(invokeCache) as unknown as CacheStorage;
};

export const createFencedWorkerHandle = <TEnv = Record<string, unknown>>(options: {
  fence: RunFence;
  runId: string;
  runtimeVars?: Record<string, unknown>;
  secret: string;
  spec: FencedWorkerSpec;
  supervisor: WorkerHandle;
}): WorkerHandle<TEnv> => {
  const { fence, runId, runtimeVars, secret, spec, supervisor } = options;

  const dispatchWorkerFetch = (targetWorkerName: string, input: RequestInfo | URL, init?: RequestInit) =>
    fence.dispatch(async () => {
      const normalizedInput =
        typeof input === "string" && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)
          ? new URL(input, "http://localhost")
          : input;
      const request =
        normalizedInput instanceof Request && init === undefined ? normalizedInput : new Request(normalizedInput, init);
      const headers = new Headers(request.headers);
      headers.set(BTCF_SECRET_HEADER, secret);
      headers.set(BTCF_RUN_ID_HEADER, runId);
      headers.set(BTCF_WORKER_HEADER, targetWorkerName);
      const origin = headers.get("Origin");
      if (origin !== null) {
        headers.delete("Origin");
        headers.set(BTCF_ORIGIN_HEADER, origin);
      }
      const forwarded = new Request(request, { headers });
      return supervisor.fetch(forwarded as any);
    });

  let cachedEnvPromise: Promise<TEnv> | undefined;

  const buildEnv = async (): Promise<TEnv> => {
    const hasBindings = Object.keys(spec.bindings).length > 0;
    const rawEnv = hasBindings ? ((await fence.dispatch(() => supervisor.getEnv())) as Record<string, any>) : {};
    const slotProxy = rawEnv.SLOT_PROXY?.getByName?.("slot") as SlotProxyStub | undefined;

    const env: Record<string, unknown> = { ...spec.vars, ...runtimeVars };
    for (const [bindingName, desc] of Object.entries(spec.bindings)) {
      switch (desc.kind) {
        case "d1":
        case "kv":
        case "r2":
        case "send_email":
        case "analytics_engine":
          env[bindingName] = rawEnv[desc.sup] ? fenceNativeBinding(rawEnv[desc.sup], fence) : undefined;
          break;
        case "queue":
          env[bindingName] = rawEnv[desc.sup] ? fenceQueueBinding(rawEnv[desc.sup], runId, fence) : undefined;
          break;
        case "do":
          env[bindingName] = rawEnv[desc.sup]
            ? fenceDurableObjectBinding(rawEnv[desc.sup], desc.sup, slotProxy, runId, fence)
            : undefined;
          break;
        case "ratelimit":
          env[bindingName] = rawEnv[desc.sup] ? fenceRateLimitBinding(rawEnv[desc.sup], runId, fence) : undefined;
          break;
        case "service":
          env[bindingName] = {
            fetch: (input: RequestInfo | URL, init?: RequestInit) => dispatchWorkerFetch(desc.target, input, init),
          };
          break;
        case "workflow": {
          const workflow = rawEnv[desc.sup] as Workflow | undefined;
          env[bindingName] = workflow
            ? createRunWorkflowBinding((operation) =>
                fence.dispatch(() =>
                  executeRunWorkflowOperation(workflow, runId, operation, (scopedId) =>
                    slotProxy?.recordCreatedWorkflow(desc.sup, scopedId),
                  ),
                ),
              )
            : undefined;
          break;
        }
        case "native":
          env[bindingName] = rawEnv[desc.sup];
          break;
      }
    }
    return env as TEnv;
  };

  const fetch = (input: RequestInfo | URL, init?: RequestInit) => dispatchWorkerFetch(spec.name, input, init);
  const rpcSupervisor = supervisor as unknown as SupervisorHandle;
  return {
    ...(rpcSupervisor.getExport && {
      getExport: () =>
        fence.dispatch(async () => {
          const entry = await rpcSupervisor.getExport!();
          return new Proxy(
            { fetch },
            {
              get(target, method) {
                if (method === "fetch") return target.fetch;
                if (typeof method !== "string" || method === "then" || method in Object.prototype) return undefined;
                return (...args: unknown[]) =>
                  fence.dispatch(() => entry.callWorker(secret, runId, spec.name, method, args));
              },
            },
          );
        }),
    }),
    fetch,
    getEnv: () => {
      fence.assertActive();
      cachedEnvPromise ??= buildEnv();
      return cachedEnvPromise;
    },
    scheduled: (options?: { cron?: string; scheduledTime?: number | Date }) =>
      fence.dispatch(async () => {
        const scheduledTime =
          options?.scheduledTime instanceof Date
            ? options.scheduledTime.getTime()
            : (options?.scheduledTime ?? Date.now());
        const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/dispatch/scheduled", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [BTCF_SECRET_HEADER]: secret,
            [BTCF_RUN_ID_HEADER]: runId,
            [BTCF_WORKER_HEADER]: spec.name,
          },
          body: JSON.stringify({ cron: options?.cron ?? "", scheduledTime }),
        });
        if (!response.ok) {
          throw new Error(`Scheduled dispatch failed (${response.status}): ${await response.text()}`);
        }
      }),
    queue: (queueName: string, messages: Array<{ body: unknown; id?: string; timestamp?: Date; attempts?: number }>) =>
      fence.dispatch(async () => {
        const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/dispatch/queue", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [BTCF_SECRET_HEADER]: secret,
            [BTCF_RUN_ID_HEADER]: runId,
            [BTCF_WORKER_HEADER]: spec.name,
          },
          body: JSON.stringify({
            queue: queueName,
            messages: messages.map((message, index) => ({
              id: message.id ?? `msg-${index}`,
              timestamp: (message.timestamp ?? new Date()).getTime(),
              attempts: message.attempts ?? 1,
              body: message.body,
            })),
          }),
        });
        if (!response.ok) {
          throw new Error(`Queue dispatch failed (${response.status}): ${await response.text()}`);
        }
        return response.json();
      }),
  } as unknown as WorkerHandle<TEnv>;
};

/** What a run sets for itself over its harness's config: see `CloudflareHarness.with()`. */
export type FencedRunSettings = {
  /**
   * Whether queue messages the run sends reach their consumers: for every Worker, or by consuming
   * Worker's name (true for one not named).
   */
  consumeQueues?: boolean | Record<string, boolean>;
};

type SlotUpdate = {
  runId: string;
  runtimeVarsByWorker?: Record<string, Record<string, unknown>>;
  settings?: FencedRunSettings;
};

type SupervisorHandle = Pick<WorkerHandle, "fetch"> & {
  getExport?: () => Promise<{
    callWorker(secret: string, runId: string, name: string, method: string, args: unknown[]): Promise<unknown>;
    updateSlot(secret: string, action: "activate" | "configure" | "retire", update?: SlotUpdate): Promise<void>;
  }>;
};
const updateSlot = async (
  handle: WorkerHandle,
  secret: string,
  action: "activate" | "configure" | "retire",
  update?: SlotUpdate,
) => {
  const supervisor = handle as unknown as SupervisorHandle;
  if (supervisor.getExport) {
    const entry = await supervisor.getExport();
    await entry.updateSlot(secret, action, update);
    return;
  }
  const response = await supervisor.fetch(`https://bun-test-cloudflare.invalid/__btcf/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", [BTCF_SECRET_HEADER]: secret },
    body: JSON.stringify(update),
  });
  if (!response.ok) throw new Error(`Fenced slot ${action} failed (${response.status}): ${await response.text()}`);
};

export const activateFencedSlot = (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  runtimeVarsByWorker?: Record<string, Record<string, unknown>>,
  settings?: FencedRunSettings,
) => updateSlot(supervisor, secret, "activate", { runId, runtimeVarsByWorker, settings });

export const configureFencedRun = (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  runtimeVarsByWorker: Record<string, Record<string, unknown>>,
  settings: FencedRunSettings,
) => updateSlot(supervisor, secret, "configure", { runId, runtimeVarsByWorker, settings });

export const retireFencedSlot = (supervisor: WorkerHandle, secret: string) => updateSlot(supervisor, secret, "retire");
