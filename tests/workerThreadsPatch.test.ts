import { expect, test } from "bun:test";
import { patchSynchronousFetcherWorkerScript } from "../src/patches/WorkerThreadsPatch";

test("patches Miniflare synchronous fetch worker to process messages FIFO", () => {
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

  expect(patched).toContain("let nextMessage = Promise.resolve();");
  expect(patched).toContain("const handleMessage = async (event) => {");
  expect(patched).toContain("nextMessage = nextMessage.then(() => handleMessage(event), () => handleMessage(event));");
  expect(patched).toContain("const responseBody = await response.arrayBuffer();");
  expect(patched).toContain("const beforeListener = true;");
  expect(patched).toContain("const afterListener = true;");
  expect(patched).not.toContain('response.headers.get("MF-Op-Result-Type") === "ReadableStream"');
});
