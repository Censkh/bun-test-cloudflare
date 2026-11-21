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

type EncodedMultipartOptions = Omit<R2MultipartOptions, "httpMetadata"> & {
  httpMetadata?: EncodeHeaders<R2MultipartOptions["httpMetadata"]>;
};

type PutValue = Parameters<R2Bucket["put"]>[1];
type EncodedStream = { response: Response; size?: number };

const isEncodedStream = (value: unknown): value is EncodedStream =>
  value !== null && typeof value === "object" && "response" in value;

export type RunR2Operation =
  | { method: "head"; key: string }
  | { method: "get"; key: string; options?: EncodedGet }
  | {
      method: "put";
      key: string;
      value: Exclude<PutValue, Blob | ReadableStream> | EncodedStream;
      options?: EncodedPut;
    }
  | { method: "delete"; keys: string | string[] }
  | { method: "list"; options?: R2ListOptions }
  | { method: "createMultipartUpload"; key: string; options?: EncodedMultipartOptions }
  | {
      method: "multipartUploadPart";
      key: string;
      uploadId: string;
      partNumber: number;
      value: Exclude<PutValue, Blob | ReadableStream> | EncodedStream;
    }
  | { method: "multipartAbort"; key: string; uploadId: string }
  | { method: "multipartComplete"; key: string; uploadId: string; uploadedParts: R2UploadedPart[] };

export type EncodedR2Object = Omit<R2Object, "checksums" | "writeHttpMetadata"> & {
  checksums: Omit<R2Checksums, "toJSON">;
  hexChecksums: R2StringChecksums;
  headers: HeaderEntries;
  response?: Response;
};

type EncodedList = Omit<R2Objects, "objects" | "truncated"> & {
  objects: EncodedR2Object[];
} & ({ truncated: false } | { truncated: true; cursor: string });

export type RunR2Binding = Pick<
  R2Bucket,
  "head" | "get" | "put" | "delete" | "list" | "createMultipartUpload" | "resumeMultipartUpload"
>;

/** Preserve native streams and reconstruct the synchronous R2 metadata methods locally. */
export function createRunR2Binding(invoke: (operation: RunR2Operation) => Promise<unknown>): RunR2Binding {
  const encodePutValue = (value: PutValue): Exclude<PutValue, Blob | ReadableStream> | EncodedStream => {
    if (value instanceof Blob) return { response: new Response(value), size: value.size };
    if (value instanceof ReadableStream) return { response: new Response(value) };
    return value;
  };
  const encode = <T>(value: T): EncodeHeaders<T> =>
    value instanceof Headers ? { headers: [...value] } : (value as EncodeHeaders<T>);

  const unpack = (object: EncodedR2Object | null) => {
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
    const expectedLength = (() => {
      const range = fields.range;
      if (!range) return fields.size;
      if ("length" in range && typeof range.length === "number") return range.length;
      if ("suffix" in range && typeof range.suffix === "number") return Math.min(range.suffix, fields.size);
      if ("offset" in range && typeof range.offset === "number") return Math.max(0, fields.size - range.offset);
      return fields.size;
    })();
    let fixedBody: ReadableStream | undefined;
    const body: R2ObjectBody = {
      ...metadata,
      get body() {
        if (!fixedBody) {
          const raw = response.body!;
          if (typeof FixedLengthStream === "function") {
            const fixed = new FixedLengthStream(expectedLength);
            void raw.pipeTo(fixed.writable).catch(() => {});
            fixedBody = fixed.readable;
          } else {
            fixedBody = raw;
          }
        }
        return fixedBody;
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

  const createMultipartHandle = (key: string, uploadId: string): R2MultipartUpload => ({
    key,
    uploadId,
    uploadPart: (partNumber, value) =>
      invoke({
        method: "multipartUploadPart",
        key,
        uploadId,
        partNumber,
        value: encodePutValue(value as PutValue),
      }) as Promise<R2UploadedPart>,
    async abort() {
      await invoke({ method: "multipartAbort", key, uploadId });
    },
    complete: async (uploadedParts) =>
      unpack(
        (await invoke({
          method: "multipartComplete",
          key,
          uploadId,
          uploadedParts,
        })) as EncodedR2Object,
      )!,
  });

  const invokeObject = async (operation: RunR2Operation) => unpack((await invoke(operation)) as EncodedR2Object | null);
  return {
    head: (key) => invokeObject({ method: "head", key }),
    get: ((key, options) =>
      invokeObject({
        method: "get",
        key,
        options: options && { ...options, range: encode(options.range), onlyIf: encode(options.onlyIf) },
      })) as R2Bucket["get"],
    put: ((key: string, value: PutValue, options?: R2PutOptions) =>
      invokeObject({
        method: "put",
        key,
        value: encodePutValue(value),
        options: options && { ...options, httpMetadata: encode(options.httpMetadata), onlyIf: encode(options.onlyIf) },
      })) as R2Bucket["put"],
    async delete(keys) {
      await invoke({ method: "delete", keys });
    },
    async list(options) {
      const result = (await invoke({ method: "list", options })) as EncodedList;
      return { ...result, objects: result.objects.map((object) => unpack(object)!) };
    },
    async createMultipartUpload(key, options) {
      const result = (await invoke({
        method: "createMultipartUpload",
        key,
        options: options && { ...options, httpMetadata: encode(options.httpMetadata) },
      })) as { key: string; uploadId: string };
      return createMultipartHandle(result.key, result.uploadId);
    },
    resumeMultipartUpload: (key, uploadId) => createMultipartHandle(key, uploadId),
  };
}

/** Execute in RunBindingProxy.perform() against a real Workerd R2 binding. */
export async function executeRunR2Operation(bucket: R2Bucket, operation: RunR2Operation) {
  const decode = <T>(value: T | { headers: HeaderEntries }) =>
    value && typeof value === "object" && "headers" in value
      ? new Headers(value.headers as HeaderEntries)
      : (value as T);
  const pack = (object: R2Object | R2ObjectBody | null): EncodedR2Object | null => {
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
      if (!isEncodedStream(value)) {
        return pack(await bucket.put(operation.key, value, decoded));
      }
      if (value.size === undefined) {
        return pack(await bucket.put(operation.key, await value.response.arrayBuffer(), decoded));
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
    case "createMultipartUpload": {
      const options = operation.options;
      const upload = await bucket.createMultipartUpload(
        operation.key,
        options && { ...options, httpMetadata: decode(options.httpMetadata) },
      );
      return { key: upload.key, uploadId: upload.uploadId };
    }
    case "multipartUploadPart": {
      const upload = bucket.resumeMultipartUpload(operation.key, operation.uploadId);
      const { value } = operation;
      if (!isEncodedStream(value)) {
        return upload.uploadPart(operation.partNumber, value as ArrayBuffer | ArrayBufferView | string);
      }
      if (value.size === undefined) {
        return upload.uploadPart(operation.partNumber, await value.response.arrayBuffer());
      }
      const stream = new FixedLengthStream(value.size);
      const cancellation = new AbortController();
      const piping = value.response.body!.pipeTo(stream.writable, { signal: cancellation.signal });
      piping.catch(() => {});
      try {
        const part = await upload.uploadPart(operation.partNumber, stream.readable);
        await piping;
        return part;
      } finally {
        cancellation.abort();
        await piping.catch(() => {});
      }
    }
    case "multipartAbort": {
      await bucket.resumeMultipartUpload(operation.key, operation.uploadId).abort();
      return;
    }
    case "multipartComplete": {
      const upload = bucket.resumeMultipartUpload(operation.key, operation.uploadId);
      return pack(await upload.complete(operation.uploadedParts));
    }
  }
}

/** Deletes all objects in an R2 bucket between fenced runs. */
export async function clearR2Bucket(bucket: R2Bucket): Promise<void> {
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({ cursor, limit: 1000 });
    if (listed.objects.length > 0) {
      await bucket.delete(listed.objects.map((object) => object.key));
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor !== undefined);
}
