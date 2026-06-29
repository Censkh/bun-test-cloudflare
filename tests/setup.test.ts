import { expect, test } from "bun:test";
import { createRequire } from "node:module";

await import("../src/setup");

const require = createRequire(import.meta.url);

test("setup exposes ws client and server constructors", () => {
  const ws = require("ws");

  expect(typeof ws.default).toBe("function");
  expect(typeof ws.WebSocket).toBe("function");
  expect(typeof ws.WebSocketServer).toBe("function");
  expect(typeof ws.Server).toBe("function");
});

test("setup installs minimal cloudflare:workers class shims", async () => {
  const moduleName = "cloudflare:workers";
  const workers = await import(moduleName);

  expect(typeof workers.DurableObject).toBe("function");
  expect(typeof workers.WorkerEntrypoint).toBe("function");
});
