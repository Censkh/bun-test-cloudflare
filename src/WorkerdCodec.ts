/**
 * Lightweight tagged JSON codec for transporting JS values (ArrayBuffer, Uint8Array, Date, Map,
 * Set, Headers, undefined) across the Bun <-> Supervisor Workerd HTTP bridge.
 */

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

export const encodeBridgeValue = (value: unknown): unknown => {
  if (value === undefined) return { __btcf_t: "undef" };
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return { __btcf_t: "date", v: value.toISOString() };
  if (value instanceof ArrayBuffer) return { __btcf_t: "ab", b: bytesToBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return { __btcf_t: "u8", b: bytesToBase64(bytes) };
  }
  if (value instanceof Headers) return { __btcf_t: "headers", v: [...value] };
  if (value instanceof Map) {
    return {
      __btcf_t: "map",
      v: Array.from(value.entries(), ([k, v]) => [encodeBridgeValue(k), encodeBridgeValue(v)]),
    };
  }
  if (value instanceof Set) {
    return { __btcf_t: "set", v: Array.from(value, (v) => encodeBridgeValue(v)) };
  }
  if (Array.isArray(value)) return value.map(encodeBridgeValue);
  const encoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) encoded[key] = encodeBridgeValue(entry);
  }
  return encoded;
};

export const decodeBridgeValue = (value: unknown): unknown => {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeBridgeValue);
  const record = value as Record<string, unknown>;
  if (typeof record.__btcf_t === "string") {
    switch (record.__btcf_t) {
      case "undef":
        return undefined;
      case "date":
        return new Date(record.v as string);
      case "ab": {
        const bytes = base64ToBytes(record.b as string);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      case "u8":
        return base64ToBytes(record.b as string);
      case "headers":
        return new Headers(record.v as [string, string][]);
      case "map":
        return new Map(
          (record.v as [unknown, unknown][]).map(([k, v]) => [decodeBridgeValue(k), decodeBridgeValue(v)]),
        );
      case "set":
        return new Set((record.v as unknown[]).map(decodeBridgeValue));
    }
  }
  const decoded: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(record)) {
    decoded[key] = decodeBridgeValue(entry);
  }
  return decoded;
};
