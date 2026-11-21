type HeaderEntries = [string, string][];
type EncodeHeaders<T> = Exclude<T, Headers> | { headers: HeaderEntries };

type EncodedGet = {
  onlyIf?: EncodeHeaders<R2GetOptions["onlyIf"]>;
  range?: EncodeHeaders<R2GetOptions["range"]>;
  ssecKey?: R2GetOptions["ssecKey"];
};

type EncodedPut = Omit<R2PutOptions, "onlyIf" | "httpMetadata"> & {
  onlyIf?: EncodeHeaders<R2PutOptions["onlyIf"]>;
  httpMetadata?: EncodeHeaders<R2PutOptions["httpMetadata"]>;
};

type PutValue = Exclude<Parameters<R2Bucket["put"]>[1], ReadableStream>;
type EncodedBlob = { response: Response; size: number };

const isEncodedBlob = (value: Exclude<PutValue, Blob> | EncodedBlob): value is EncodedBlob =>
  value !== null && typeof value === "object" && "response" in value;

export type RunR2Operation =
  | { method: "head"; key: string }
  | { method: "get"; key: string; options?: EncodedGet }
  | { method: "put"; key: string; value: Exclude<PutValue, Blob> | EncodedBlob; options?: EncodedPut }
  | { method: "delete"; keys: string | string[] }
  | { method: "list"; options?: R2ListOptions };

type EncodedObject = Omit<R2Object, "checksums" | "writeHttpMetadata"> & {
  checksums: Omit<R2Checksums, "toJSON">;
  hexChecksums: R2StringChecksums;
  headers: HeaderEntries;
  response?: Response;
};

type EncodedList = Omit<R2Objects, "objects" | "truncated"> & {
  objects: EncodedObject[];
} & ({ truncated: false } | { truncated: true; cursor: string });

export type RunR2Binding = Pick<R2Bucket, "head" | "get" | "delete" | "list"> & {
  put(key: string, value: PutValue, options?: R2PutOptions): Promise<R2Object | null>;
};

/** Preserve native streams and reconstruct the synchronous R2 metadata methods locally. */
export function createRunR2Binding(invoke: (operation: RunR2Operation) => Promise<unknown>): RunR2Binding {
  const encode = <T>(value: T): EncodeHeaders<T> =>
    value instanceof Headers ? { headers: [...value] } : (value as EncodeHeaders<T>);

  const unpack = (object: EncodedObject | null) => {
    if (object === null) return null;
    const { response, headers, checksums, hexChecksums, ...fields } = object;
    const metadata = {
      ...fields,
      checksums: { ...checksums, toJSON: () => hexChecksums },
      writeHttpMetadata(target) {
        for (const [name, value] of headers) target.set(name, value);
      },
    } satisfies R2Object;
    if (!response) return metadata;
    const body: R2ObjectBody = {
      ...metadata,
      get body() {
        return response.body!;
      },
      get bodyUsed() {
        return response.bodyUsed;
      },
      arrayBuffer: () => response.arrayBuffer(),
      bytes: () => response.bytes(),
      text: () => response.text(),
      json: () => response.json(),
      blob: () => response.blob(),
    };
    return body;
  };

  const invokeObject = async (operation: RunR2Operation) => unpack((await invoke(operation)) as EncodedObject | null);
  return {
    head: (key) => invokeObject({ method: "head", key }),
    get: ((key, options) =>
      invokeObject({
        method: "get",
        key,
        options: options && { ...options, range: encode(options.range), onlyIf: encode(options.onlyIf) },
      })) as R2Bucket["get"],
    put: (key, value, options) =>
      invokeObject({
        method: "put",
        key,
        value: value instanceof Blob ? { response: new Response(value), size: value.size } : value,
        options: options && { ...options, httpMetadata: encode(options.httpMetadata), onlyIf: encode(options.onlyIf) },
      }),
    async delete(keys) {
      await invoke({ method: "delete", keys });
    },
    async list(options) {
      const result = (await invoke({ method: "list", options })) as EncodedList;
      return { ...result, objects: result.objects.map((object) => unpack(object)!) };
    },
  };
}

/** Execute in RunBindingProxy.perform() against a real Workerd R2 binding. */
export async function executeRunR2Operation(bucket: R2Bucket, operation: RunR2Operation) {
  const decode = <T>(value: T | { headers: HeaderEntries }) =>
    value && typeof value === "object" && "headers" in value
      ? new Headers(value.headers as HeaderEntries)
      : (value as T);
  const pack = (object: R2Object | R2ObjectBody | null): EncodedObject | null => {
    if (!object) return null;
    const headers = new Headers();
    object.writeHttpMetadata(headers);
    const { md5, sha1, sha256, sha384, sha512 } = object.checksums;
    return {
      key: object.key,
      version: object.version,
      size: object.size,
      etag: object.etag,
      httpEtag: object.httpEtag,
      uploaded: object.uploaded,
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
      range: object.range,
      storageClass: object.storageClass,
      ssecKeyMd5: object.ssecKeyMd5,
      checksums: { md5, sha1, sha256, sha384, sha512 },
      hexChecksums: object.checksums.toJSON(),
      headers: [...headers],
      response: "body" in object ? new Response(object.body, { headers }) : undefined,
    };
  };
  switch (operation.method) {
    case "head":
      return pack(await bucket.head(operation.key));
    case "get": {
      const options = operation.options;
      return pack(
        await bucket.get(
          operation.key,
          options && { ...options, onlyIf: decode(options.onlyIf), range: decode(options.range) },
        ),
      );
    }
    case "put": {
      const { options, value } = operation;
      const decoded = options && {
        ...options,
        onlyIf: decode(options.onlyIf),
        httpMetadata: decode(options.httpMetadata),
      };
      if (!isEncodedBlob(value)) {
        return pack(await bucket.put(operation.key, value, decoded));
      }
      // RPC transfers the stream but drops its known length. Restore the Blob's exact length
      // without buffering its upload before handing the stream to native R2.
      const stream = new FixedLengthStream(value.size);
      const cancellation = new AbortController();
      const upload = value.response.body!.pipeTo(stream.writable, { signal: cancellation.signal });
      upload.catch(() => {});
      try {
        const object = await bucket.put(operation.key, stream.readable, decoded);
        if (object) await upload;
        return pack(object);
      } finally {
        // A failed precondition can return without consuming the body.
        cancellation.abort();
        await upload.catch(() => {});
      }
    }
    case "delete":
      return bucket.delete(operation.keys);
    case "list": {
      const result = await bucket.list(operation.options);
      return { ...result, objects: result.objects.map(pack) };
    }
  }
}
