import { mock } from "bun:test";
import type * as WorkerThreads from "node:worker_threads";

const synchronousFetcherMessageHandlerStart = `port.addEventListener("message", async (event) => {`;
const synchronousFetcherMessageHandlerEnd = `\n\nport.start();`;
const synchronousFetcherRequiredCode = `headers["${"MF-Op-Sync"}"] = "true";`;

const synchronousFetcherPatchedMessageHandler = `let nextMessage = Promise.resolve();

const handleMessage = async (event) => {
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
    headers["${"MF-Op-Sync"}"] = "true";
    // body cannot be a ReadableStream, so no need to specify duplex
    const response = await fetch(url, { method, headers, body, dispatcher });
    const responseBody = await response.arrayBuffer();
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
};

port.addEventListener("message", (event) => {
  nextMessage = nextMessage.then(() => handleMessage(event), () => handleMessage(event));
});

port.start();`;

export const patchSynchronousFetcherWorkerScript = (script: string) => {
  const startIndex = script.indexOf(synchronousFetcherMessageHandlerStart);
  if (startIndex < 0 || !script.includes(synchronousFetcherRequiredCode)) {
    return script;
  }

  const endIndex = script.indexOf(synchronousFetcherMessageHandlerEnd, startIndex);
  if (endIndex < 0) {
    return script;
  }

  // Bun can overlap Miniflare synchronous proxy calls enough for the worker
  // bridge to post responses out of order. Miniflare's host side expects the
  // next port message id to match the blocked call, so process requests FIFO.
  // Bun also cannot reliably transfer the live response ReadableStream here, so
  // buffer it and reconstruct the stream in receiveMessageOnPort() below.
  return `${script.slice(0, startIndex)}${synchronousFetcherPatchedMessageHandler}${script.slice(
    endIndex + synchronousFetcherMessageHandlerEnd.length,
  )}`;
};

export const installWorkerThreadsPatch = () => {
  const workerThreads = require("node:worker_threads") as typeof WorkerThreads;

  class WorkerThreadsCompatWorker extends workerThreads.Worker {
    constructor(filename: string | URL, options?: WorkerThreads.WorkerOptions) {
      super(
        typeof filename === "string" && options?.eval ? patchSynchronousFetcherWorkerScript(filename) : filename,
        options,
      );
    }
  }

  const originalReceiveMessageOnPort = workerThreads.receiveMessageOnPort;
  const receiveMessageOnPort = (port: WorkerThreads.MessagePort) => {
    const message = originalReceiveMessageOnPort(port);
    const response = message?.message?.response;
    if (!response || !(response.body instanceof ArrayBuffer)) {
      return message;
    }

    const resultType = response.headers?.["mf-op-result-type"] ?? response.headers?.["MF-Op-Result-Type"];
    if (resultType !== "ReadableStream") {
      return message;
    }

    response.body = new Blob([new Uint8Array(response.body)]).stream();
    return message;
  };

  workerThreads.Worker = WorkerThreadsCompatWorker as typeof workerThreads.Worker;
  workerThreads.receiveMessageOnPort = receiveMessageOnPort as typeof workerThreads.receiveMessageOnPort;

  mock.module("node:worker_threads", () => ({
    ...workerThreads,
    Worker: WorkerThreadsCompatWorker,
    default: {
      ...workerThreads,
      Worker: WorkerThreadsCompatWorker,
      receiveMessageOnPort,
    },
    receiveMessageOnPort,
  }));
};
