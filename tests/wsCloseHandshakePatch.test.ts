import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { installWsCloseHandshakePatch } from "../src/patches/WsCloseHandshakePatch";

// A server that sends a close frame and, like workerd, keeps its side of the connection open.
const startServerHoldingClosedSockets = async () => {
  const sockets: Socket[] = [];
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.push(socket);
    socket.once("data", (request) => {
      const key = /Sec-WebSocket-Key: (\S+)/i.exec(request.toString())?.[1] ?? "";
      const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const reason = Buffer.from("revoked");
      const payload = Buffer.concat([Buffer.from([0x03, 0xf0]), reason]);
      socket.write(Buffer.concat([Buffer.from([0x88, payload.length]), payload]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `ws://127.0.0.1:${port}/`,
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
};

test("Miniflare's ws reports a server close once the close handshake completes", async () => {
  const server = await startServerHoldingClosedSockets();
  try {
    installWsCloseHandshakePatch();
    // Miniflare loads `ws` with require().
    const WebSocket = (require("ws") as typeof import("ws")).default;
    const ws = new WebSocket(server.url);
    const closed = new Promise<[number, string]>((resolve) =>
      ws.on("close", (code: number, reason: Buffer) => resolve([code, reason.toString()])),
    );
    const outcome = await Promise.race([closed, Bun.sleep(3_000).then(() => "still open")]);
    expect(outcome).toEqual([1008, "revoked"]);
  } finally {
    server.close();
  }
});
