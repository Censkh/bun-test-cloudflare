import { mock } from "bun:test";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const wsPackageJsonPath = require.resolve("ws/package.json");
const ws = require(path.join(path.dirname(wsPackageJsonPath), "index.js"));

declare global {
  var __bunTestCloudflareNativeWebSocket: typeof WebSocket | undefined;
}

globalThis.__bunTestCloudflareNativeWebSocket ??= globalThis.WebSocket;

class WebSocketCompat extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  #socket: WebSocket;
  #readyState = WebSocketCompat.CONNECTING;

  constructor(address: string | URL, protocols?: string | string[], options?: { headers?: Record<string, string> }) {
    super();
    const NativeWebSocket = globalThis.__bunTestCloudflareNativeWebSocket ?? globalThis.WebSocket;
    this.#socket =
      protocols === undefined
        ? new NativeWebSocket(address, { headers: options?.headers } as unknown as string[])
        : new NativeWebSocket(address, protocols);

    this.#socket.addEventListener("open", () => {
      this.#readyState = WebSocketCompat.OPEN;
      this.emit("upgrade", { headers: {} });
      this.emit("open");
    });
    this.#socket.addEventListener("message", (event) => {
      const data = typeof event.data === "string" ? event.data : Buffer.from(event.data);
      this.emit("message", data, typeof event.data !== "string");
    });
    this.#socket.addEventListener("close", (event) => {
      this.#readyState = WebSocketCompat.CLOSED;
      this.emit("close", event.code, Buffer.from(event.reason));
    });
    this.#socket.addEventListener("error", (event) => {
      this.emit("error", event);
    });
  }

  get readyState() {
    return this.#readyState;
  }

  send(data: string | ArrayBuffer | Buffer) {
    this.#socket.send(data as string | ArrayBuffer);
  }

  close(code?: number, reason?: string) {
    this.#readyState = WebSocketCompat.CLOSING;
    this.#socket.close(code, reason);
  }

  terminate() {
    this.close();
  }
}

const wsModule = Object.assign(WebSocketCompat, ws, {
  default: WebSocketCompat,
  Server: ws.Server,
  WebSocket: WebSocketCompat,
  WebSocketServer: ws.WebSocketServer,
});

// Bun resolves bare `ws` to its built-in compatibility shim. Miniflare expects
// Node-style `upgrade` events from `ws`; this adapter uses Bun's native client
// WebSocket while preserving npm `ws` server exports for Miniflare internals.
mock.module("ws", () => wsModule);

globalThis.WebSocket = WebSocketCompat as unknown as typeof globalThis.WebSocket;

mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {
    protected ctx: unknown;
    protected env: unknown;

    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));
