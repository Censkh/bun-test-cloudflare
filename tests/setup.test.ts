import { expect, test } from "bun:test";
import { shouldInstallCompatibilityPatch } from "../src/CompatibilityPatches";

await import("../src/setup");

test("setup exposes ws client and server constructors", () => {
  const ws = require("ws");

  if (shouldInstallCompatibilityPatch("websocket")) {
    expect(typeof ws.default).toBe("function");
  }
  expect(typeof ws.WebSocket).toBe("function");
  expect(typeof ws.WebSocketServer).toBe("function");
  expect(typeof ws.Server).toBe("function");
});

test("setup installs minimal cloudflare:workers class shims", async () => {
  const moduleName = "cloudflare:workers";
  const workers = await import(moduleName);

  if (shouldInstallCompatibilityPatch("cloudflare-workers-durable-object")) {
    expect(typeof workers.DurableObject).toBe("function");
  }
  if (shouldInstallCompatibilityPatch("cloudflare-workers-worker-entrypoint")) {
    expect(typeof workers.WorkerEntrypoint).toBe("function");
  }
});
