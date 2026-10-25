import { mock } from "bun:test";

type BunWs = {
  _closeFrameReceived?: boolean;
  _closeFrameSent?: boolean;
  _readyState?: number;
  readyState: number;
  terminate(): void;
};

type WsConstructor = (new (
  ...args: unknown[]
) => BunWs) & {
  CLOSING: number;
  CLOSED: number;
};

/**
 * From Bun 1.4.4, Bun's own `ws` emits `close` only once the server ends the TCP connection (1.4.3
 * emitted it on the close frame). After a Worker closes a WebSocket, workerd keeps its side open for
 * about ten seconds, so Miniflare's coupled WebSocket reported the close that late. Once both close
 * frames are exchanged, drop the connection; the socket then emits `close` with the server's code
 * and reason.
 */
export const endSocketAfterCloseHandshake = (ws: BunWs, closing: number, closed: number) => {
  let state = ws._readyState;
  let ended = false;
  Object.defineProperty(ws, "_readyState", {
    configurable: true,
    get: () => state,
    set: (value: number) => {
      state = value;
      if (!ended && value === closing && ws._closeFrameReceived && ws._closeFrameSent) {
        ended = true;
        setTimeout(() => {
          if (ws.readyState !== closed) ws.terminate();
        }, 0);
      }
    },
  });
};

export const installWsCloseHandshakePatch = () => {
  const BuiltinWs = require("ws") as WsConstructor;
  const WebSocket = function WebSocket(...args: unknown[]) {
    const ws = new BuiltinWs(...args);
    endSocketAfterCloseHandshake(ws, BuiltinWs.CLOSING, BuiltinWs.CLOSED);
    return ws;
  } as unknown as WsConstructor;
  WebSocket.prototype = BuiltinWs.prototype;
  // Miniflare constructs `ws`'s default export and reads its static readyState constants.
  const wsModule = Object.assign(WebSocket, BuiltinWs, { default: WebSocket, WebSocket });
  mock.module("ws", () => wsModule);
};
