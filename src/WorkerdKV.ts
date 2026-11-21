type KVGetType = "text" | "json" | "arrayBuffer" | "stream";

type EncodedKVGetOptions = KVGetType | { type?: KVGetType; cacheTtl?: number };
type EncodedKVPutValue = string | ArrayBuffer | ArrayBufferView | { response: Response };

export type RunKVOperation =
  | { method: "get"; key: string | string[]; options?: EncodedKVGetOptions }
  | { method: "getWithMetadata"; key: string | string[]; options?: EncodedKVGetOptions }
  | { method: "put"; key: string; value: EncodedKVPutValue; options?: KVNamespacePutOptions }
  | { method: "delete"; key: string }
  | { method: "list"; options?: KVNamespaceListOptions };

type EncodedStreamValue = { __btcf_stream: true; response: Response };

const isEncodedPutStream = (value: unknown): value is { response: Response } =>
  value !== null && typeof value === "object" && "response" in value;

const getRequestedType = (options?: EncodedKVGetOptions): KVGetType =>
  typeof options === "string" ? options : (options?.type ?? "text");

export function createRunKVBinding(invoke: (operation: RunKVOperation) => Promise<unknown>): KVNamespace {
  const requestedType = (options?: EncodedKVGetOptions): KVGetType =>
    typeof options === "string" ? options : (options?.type ?? "text");
  const unwrapStream = (value: unknown): unknown =>
    value !== null && typeof value === "object" && "__btcf_stream" in value
      ? (value as EncodedStreamValue).response.body
      : value;

  return {
    async get(key: string | string[], options?: EncodedKVGetOptions) {
      const result = await invoke({ method: "get", key, options });
      if (Array.isArray(key) || requestedType(options) !== "stream") return result;
      return unwrapStream(result);
    },
    async getWithMetadata(key: string | string[], options?: EncodedKVGetOptions) {
      const result = (await invoke({ method: "getWithMetadata", key, options })) as
        | { value: unknown; metadata: unknown; cacheStatus: string | null }
        | Map<string, { value: unknown; metadata: unknown }>;
      if (Array.isArray(key) || requestedType(options) !== "stream") return result;
      const single = result as { value: unknown; metadata: unknown; cacheStatus: string | null };
      return { ...single, value: unwrapStream(single.value) };
    },
    async put(
      key: string,
      value: string | ArrayBuffer | ArrayBufferView | ReadableStream,
      options?: KVNamespacePutOptions,
    ) {
      const encoded: EncodedKVPutValue = value instanceof ReadableStream ? { response: new Response(value) } : value;
      await invoke({ method: "put", key, value: encoded, options });
    },
    async delete(key: string) {
      await invoke({ method: "delete", key });
    },
    list: (options?: KVNamespaceListOptions) =>
      invoke({ method: "list", options }) as Promise<KVNamespaceListResult<unknown, string>>,
  } as unknown as KVNamespace;
}

export async function executeRunKVOperation(kv: KVNamespace, operation: RunKVOperation): Promise<unknown> {
  switch (operation.method) {
    case "get": {
      if (Array.isArray(operation.key)) {
        return kv.get(operation.key, operation.options as any);
      }
      const value: unknown = await kv.get(operation.key, operation.options as any);
      if (getRequestedType(operation.options) === "stream" && value instanceof ReadableStream) {
        return { __btcf_stream: true, response: new Response(value) } satisfies EncodedStreamValue;
      }
      return value;
    }
    case "getWithMetadata": {
      if (Array.isArray(operation.key)) {
        return kv.getWithMetadata(operation.key, operation.options as any);
      }
      const result = (await kv.getWithMetadata(operation.key, operation.options as any)) as {
        value: unknown;
        metadata: unknown;
        cacheStatus: string | null;
      };
      if (getRequestedType(operation.options) === "stream" && result.value instanceof ReadableStream) {
        return {
          ...result,
          value: { __btcf_stream: true, response: new Response(result.value) } satisfies EncodedStreamValue,
        };
      }
      return result;
    }
    case "put": {
      const value = isEncodedPutStream(operation.value) ? operation.value.response.body! : operation.value;
      await kv.put(operation.key, value, operation.options);
      return;
    }
    case "delete":
      await kv.delete(operation.key);
      return;
    case "list":
      return kv.list(operation.options);
  }
}

/** Deletes all keys in a KV namespace between fenced runs. */
export async function clearKVNamespace(kv: KVNamespace): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await kv.list({ cursor, limit: 1000 });
    if (listed.keys.length > 0) {
      await Promise.all(listed.keys.map((entry) => kv.delete(entry.name)));
    }
    cursor = !listed.list_complete && "cursor" in listed ? listed.cursor : undefined;
  } while (cursor !== undefined);
}
