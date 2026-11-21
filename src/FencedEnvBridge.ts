import type { WorkerHandle } from "wrangler";
import type { RunFence } from "./RunFence";
import type { RunCacheOperation } from "./WorkerdCache";
import { createRunCacheStorage } from "./WorkerdCache";
import { decodeBridgeValue, encodeBridgeValue } from "./WorkerdCodec";
import { createRunD1Binding, type RunD1Operation } from "./WorkerdD1";
import { createRunDurableObjectNamespace, type RunDurableObjectOperation } from "./WorkerdDurableObject";
import { createRunKVBinding, type RunKVOperation } from "./WorkerdKV";
import { createRunQueueBinding, type RunQueueOperation } from "./WorkerdQueue";
import { createRunR2Binding, type RunR2Operation } from "./WorkerdR2";
import { createRunRateLimitBinding, type RunRateLimitOperation } from "./WorkerdRateLimit";

export const BTCF_SECRET_HEADER = "x-btcf-secret";
export const BTCF_RUN_ID_HEADER = "x-btcf-run-id";
export const BTCF_WORKER_HEADER = "x-btcf-worker";
export const BTCF_META_HEADER = "x-btcf-meta";

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
  | { kind: "native"; sup: string };

export type FencedWorkerSpec = {
  bindings: Record<string, FencedBindingDescriptor>;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  name: string;
  vars: Record<string, unknown>;
};

type BridgeErrorPayload = {
  __btcf_error: {
    message: string;
    name?: string;
  };
};

const isBridgeError = (value: unknown): value is BridgeErrorPayload =>
  value !== null && typeof value === "object" && "__btcf_error" in value;

const rethrowBridgeError = (payload: BridgeErrorPayload): never => {
  const error = new Error(payload.__btcf_error.message);
  if (payload.__btcf_error.name) error.name = payload.__btcf_error.name;
  throw error;
};

type EncodedHttpBody = {
  body?: string | ArrayBuffer | Uint8Array | null;
  meta: unknown;
};

const toUint8Array = (value: ArrayBuffer | ArrayBufferView): Uint8Array =>
  value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);

/**
 * Splits out Request / Response bodies from operations so binary payloads stream as the HTTP
 * body instead of being base64-encoded inside JSON headers.
 */
const encodeOperationForHttp = async (name: string, operation: unknown): Promise<EncodedHttpBody> => {
  if (name === "cache") {
    const op = operation as RunCacheOperation;
    const serializedRequest = {
      url: op.request.url,
      method: op.request.method,
      headers: [...op.request.headers],
    };
    if (op.method === "put") {
      const body = await op.response.arrayBuffer();
      return {
        meta: {
          name,
          op: {
            cacheName: op.cacheName,
            method: "put",
            request: serializedRequest,
            response: {
              status: op.response.status,
              statusText: op.response.statusText,
              headers: [...op.response.headers],
            },
          },
        },
        body,
      };
    }
    return {
      meta: {
        name,
        op: {
          cacheName: op.cacheName,
          method: op.method,
          request: serializedRequest,
          options: op.options,
        },
      },
    };
  }

  if (name.startsWith("r2:")) {
    const op = operation as RunR2Operation;
    if (op.method === "put") {
      const value = op.value;
      if (value !== null && typeof value === "object" && "response" in value) {
        const body = await value.response.arrayBuffer();
        return {
          meta: { name, op: { method: "put", key: op.key, options: op.options, hasBody: true, size: value.size } },
          body,
        };
      }
      if (typeof value === "string") {
        return {
          meta: { name, op: { method: "put", key: op.key, options: op.options, hasBody: true, isString: true } },
          body: value,
        };
      }
      if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        return {
          meta: { name, op: { method: "put", key: op.key, options: op.options, hasBody: true } },
          body: toUint8Array(value),
        };
      }
      return { meta: { name, op: { method: "put", key: op.key, options: op.options, hasBody: false } } };
    }
    if (op.method === "multipartUploadPart") {
      const value = op.value;
      let body: string | ArrayBuffer | Uint8Array;
      if (value !== null && typeof value === "object" && "response" in value) {
        body = await value.response.arrayBuffer();
      } else if (typeof value === "string") {
        body = value;
      } else {
        body = toUint8Array(value as ArrayBuffer | ArrayBufferView);
      }
      return {
        meta: {
          name,
          op: { method: "multipartUploadPart", key: op.key, uploadId: op.uploadId, partNumber: op.partNumber },
        },
        body,
      };
    }
  }

  if (name.startsWith("kv:")) {
    const op = operation as RunKVOperation;
    if (op.method === "put") {
      const value = op.value;
      if (typeof value === "string") {
        return {
          meta: { name, op: { method: "put", key: op.key, options: op.options, valueKind: "string" } },
          body: value,
        };
      }
      if (value !== null && typeof value === "object" && "response" in value) {
        return {
          meta: { name, op: { method: "put", key: op.key, options: op.options, valueKind: "bytes" } },
          body: await value.response.arrayBuffer(),
        };
      }
      return {
        meta: { name, op: { method: "put", key: op.key, options: op.options, valueKind: "bytes" } },
        body: toUint8Array(value as ArrayBuffer | ArrayBufferView),
      };
    }
  }

  if (name.startsWith("do:")) {
    const op = operation as RunDurableObjectOperation;
    if (op.method === "fetch") {
      const hasBody = op.request.body !== null;
      const body = hasBody ? await op.request.arrayBuffer() : undefined;
      return {
        meta: {
          name,
          op: {
            method: "fetch",
            target: op.target,
            request: {
              url: op.request.url,
              method: op.request.method,
              headers: [...op.request.headers],
            },
          },
        },
        body,
      };
    }
  }

  return { meta: { name, op: encodeBridgeValue(operation) } };
};

const invokeSupervisorBridge = async (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  fence: RunFence,
  name: string,
  operation: unknown,
): Promise<unknown> =>
  fence.dispatch(async () => {
    const encoded = await encodeOperationForHttp(name, operation);
    const headers: Record<string, string> = {
      [BTCF_SECRET_HEADER]: secret,
      [BTCF_RUN_ID_HEADER]: runId,
    };
    let body: string | ArrayBuffer | Uint8Array | null | undefined;
    if (encoded.body !== undefined) {
      headers[BTCF_META_HEADER] = encodeURIComponent(JSON.stringify(encoded.meta));
      headers["content-type"] = "application/octet-stream";
      body = encoded.body;
    } else {
      headers["content-type"] = "application/json";
      body = JSON.stringify(encoded.meta);
    }

    const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/env", {
      method: "POST",
      headers,
      body: body as any,
    });

    const responseMetaHeader = response.headers.get(BTCF_META_HEADER);
    if (responseMetaHeader !== null) {
      const meta = decodeBridgeValue(JSON.parse(decodeURIComponent(responseMetaHeader))) as Record<string, unknown>;
      if (isBridgeError(meta)) rethrowBridgeError(meta);
      const rawBytes = await response.arrayBuffer();
      if (meta.__btcf_kind === "r2-object") {
        const obj = meta.object as Record<string, unknown>;
        const respHeaders = new Headers((obj.headers as [string, string][]) ?? []);
        return { ...obj, response: new Response(rawBytes, { headers: respHeaders }) };
      }
      if (meta.__btcf_kind === "response") {
        const status = meta.status as number;
        const statusText = (meta.statusText as string) ?? "";
        const respHeaders = new Headers((meta.headers as [string, string][]) ?? []);
        const isNullBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
        return new Response(isNullBodyStatus ? null : rawBytes, { status, statusText, headers: respHeaders });
      }
      if (meta.__btcf_kind === "kv-stream") {
        return { __btcf_stream: true, response: new Response(rawBytes) };
      }
      if (meta.__btcf_kind === "kv-stream-meta") {
        return {
          value: { __btcf_stream: true, response: new Response(rawBytes) },
          metadata: meta.metadata,
          cacheStatus: meta.cacheStatus,
        };
      }
      return meta.value;
    }

    if (response.status === 204) return undefined;
    const text = await response.text();
    if (!text) return undefined;
    const parsed = decodeBridgeValue(JSON.parse(text));
    if (isBridgeError(parsed)) rethrowBridgeError(parsed);
    if (!response.ok) {
      throw new Error(`Fenced binding bridge failed (${response.status}): ${text}`);
    }
    return parsed;
  });

export const createFencedBunCacheStorage = (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  fence: RunFence,
): CacheStorage => {
  const storage = createRunCacheStorage((operation) =>
    invokeSupervisorBridge(supervisor, secret, runId, fence, "cache", operation),
  );
  return storage as unknown as CacheStorage;
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
      const forwarded = new Request(request, { headers });
      return supervisor.fetch(forwarded as any);
    });

  let cachedEnvPromise: Promise<TEnv> | undefined;

  const buildEnv = async (): Promise<TEnv> => {
    const needsNative = Object.values(spec.bindings).some((desc) => desc.kind === "native");
    const supervisorNativeEnv = needsNative
      ? ((await fence.dispatch(() => supervisor.getEnv())) as Record<string, unknown>)
      : undefined;

    const env: Record<string, unknown> = { ...spec.vars, ...runtimeVars };
    for (const [bindingName, desc] of Object.entries(spec.bindings)) {
      switch (desc.kind) {
        case "d1":
          env[bindingName] = createRunD1Binding((op: RunD1Operation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `d1:${desc.sup}`, op),
          );
          break;
        case "kv":
          env[bindingName] = createRunKVBinding((op: RunKVOperation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `kv:${desc.sup}`, op),
          );
          break;
        case "r2":
          env[bindingName] = createRunR2Binding((op: RunR2Operation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `r2:${desc.sup}`, op),
          );
          break;
        case "queue":
          env[bindingName] = createRunQueueBinding((op: RunQueueOperation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `queue:${desc.sup}`, op),
          );
          break;
        case "do":
          env[bindingName] = createRunDurableObjectNamespace((op: RunDurableObjectOperation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `do:${desc.sup}`, op),
          );
          break;
        case "ratelimit":
          env[bindingName] = createRunRateLimitBinding((op: RunRateLimitOperation) =>
            invokeSupervisorBridge(supervisor, secret, runId, fence, `ratelimit:${desc.sup}`, op),
          );
          break;
        case "service":
          env[bindingName] = {
            fetch: (input: RequestInfo | URL, init?: RequestInit) => dispatchWorkerFetch(desc.target, input, init),
          };
          break;
        case "send_email":
          env[bindingName] = {
            send: (message: unknown) =>
              invokeSupervisorBridge(supervisor, secret, runId, fence, `email:${desc.sup}`, message),
          };
          break;
        case "analytics_engine":
          env[bindingName] = {
            writeDataPoint: (event?: unknown) => {
              void invokeSupervisorBridge(supervisor, secret, runId, fence, `ae:${desc.sup}`, event).catch(() => {});
            },
          };
          break;
        case "native":
          env[bindingName] = supervisorNativeEnv?.[desc.sup];
          break;
      }
    }
    return env as TEnv;
  };

  return {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => dispatchWorkerFetch(spec.name, input, init),
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
          body: JSON.stringify(
            encodeBridgeValue({
              queue: queueName,
              messages: messages.map((message, index) => ({
                id: message.id ?? `msg-${index}`,
                timestamp: (message.timestamp ?? new Date()).getTime(),
                attempts: message.attempts ?? 1,
                body: message.body,
              })),
            }),
          ),
        });
        if (!response.ok) {
          throw new Error(`Queue dispatch failed (${response.status}): ${await response.text()}`);
        }
        return response.json();
      }),
  } as unknown as WorkerHandle<TEnv>;
};

export const activateFencedSlot = async (
  supervisor: WorkerHandle,
  secret: string,
  runId: string,
  runtimeVarsByWorker?: Record<string, Record<string, unknown>>,
): Promise<void> => {
  const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/activate", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [BTCF_SECRET_HEADER]: secret,
      [BTCF_RUN_ID_HEADER]: runId,
    },
    body: JSON.stringify({ runId, runtimeVarsByWorker }),
  });
  if (!response.ok) {
    throw new Error(`Failed activating fenced slot (${response.status}): ${await response.text()}`);
  }
};

export const retireFencedSlot = async (supervisor: WorkerHandle, secret: string): Promise<void> => {
  const response = await supervisor.fetch("https://bun-test-cloudflare.invalid/__btcf/retire", {
    method: "POST",
    headers: {
      [BTCF_SECRET_HEADER]: secret,
    },
  });
  if (!response.ok) {
    throw new Error(`Failed retiring fenced slot (${response.status}): ${await response.text()}`);
  }
};
