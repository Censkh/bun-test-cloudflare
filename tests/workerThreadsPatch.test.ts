import { expect, test } from "bun:test";
import { shouldInstallCompatibilityPatch } from "../src/CompatibilityPatches";
import { installWorkerThreadsPatch, patchSynchronousFetcherWorkerScript } from "../src/patches/WorkerThreadsPatch";

test("bridges Miniflare synchronous fetch response streams without replacing its handler", () => {
  const script = `
const { notifyHandle, port } = workerData;
const beforeListener = true;

port.addEventListener("message", async (event) => {
  const { id, method, url, headers, body } = event.data;
  try {
    if (dispatcherUrl !== url) {
      dispatcherUrl = url;
      dispatcher = new Pool(new URL(url).origin, {
        connect: { rejectUnauthorized: false },
              // Disable timeouts for local dev — long-running responses (streaming,
      // slow uploads, long-polling) should not be killed by undici defaults.
      headersTimeout: 0,
      bodyTimeout: 0,
      });
    }
    headers["MF-Op-Sync"] = "true";
    // body cannot be a ReadableStream, so no need to specify duplex
    const response = await fetch(url, { method, headers, body, dispatcher });
    const responseBody = response.headers.get("MF-Op-Result-Type") === "ReadableStream"
      ? response.body
      : await response.arrayBuffer();
    const transferList = responseBody === null ? undefined : [responseBody];
    port.postMessage(
      {
        id,
        response: {
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: responseBody,
        }
      },
      transferList
    );
  } catch (error) {
    try {
      port.postMessage({ id, error });
    } catch {
      // If error failed to serialise, post simplified version
      port.postMessage({ id, error: new Error(String(error)) });
    }
  } finally {
    Atomics.store(notifyHandle, /* index */ 0, /* value */ 1);
    Atomics.notify(notifyHandle, /* index */ 0);
  }
});

port.start();

const afterListener = true;`;

  const patched = patchSynchronousFetcherWorkerScript(script);

  expect(patched).toContain("__bunTestCloudflareMessagePort.prototype.postMessage = function");
  expect(patched).toContain("__bunTestCloudflareStreamPort: port1");
  expect(patched).toContain('port.addEventListener("message", async (event) => {');
  expect(patched).toContain("Atomics.store(notifyHandle, /* index */ 0, /* value */ 1);");
  expect(patched).toContain("const beforeListener = true;");
  expect(patched).toContain("const afterListener = true;");
});

test("buffers out-of-order synchronous fetch responses by id", () => {
  if (!shouldInstallCompatibilityPatch("worker-threads-fifo")) {
    return;
  }

  installWorkerThreadsPatch();

  const workerThreads = require("node:worker_threads") as typeof import("node:worker_threads");
  const { port1, port2 } = new workerThreads.MessageChannel();

  try {
    port1.postMessage({ id: 0, method: "POST", url: "http://localhost/session", headers: {} });
    port2.postMessage({ id: 1, response: { status: 200, headers: {}, body: new Uint8Array([1]).buffer } });
    port2.postMessage({ id: 0, response: { status: 200, headers: {}, body: new Uint8Array([0]).buffer } });

    const first = workerThreads.receiveMessageOnPort(port1);
    expect(first?.message.id).toBe(0);

    port1.postMessage({ id: 1, method: "POST", url: "http://localhost/session", headers: {} });

    const second = workerThreads.receiveMessageOnPort(port1);
    expect(second?.message.id).toBe(1);
  } finally {
    port1.close();
    port2.close();
  }
});
