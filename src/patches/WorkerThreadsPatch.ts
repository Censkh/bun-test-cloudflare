import { mock } from "bun:test";
import type * as WorkerThreads from "node:worker_threads";

const synchronousFetcherMessageHandlerStart = `port.addEventListener("message", async (event) => {`;
const synchronousFetcherMessageHandlerEnd = `\n\nport.start();`;
const synchronousFetcherRequiredCode = `headers["${"MF-Op-Sync"}"] = "true";`;

const synchronousFetcherPatchedMessageHandler = `let nextMessage = Promise.resolve();

const serialiseError = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.name : "Error",
  stack: error instanceof Error ? error.stack : undefined,
});

const transferChunk = (chunk) => {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk;
  }
  return new Uint8Array(chunk);
};

const createStreamBridge = (stream) => {
  const { MessageChannel } = require("worker_threads");
  const { port1, port2 } = new MessageChannel();
  const reader = stream.getReader();

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          port2.postMessage({ done: true });
          break;
        }
        const chunk = transferChunk(value);
        port2.postMessage({ chunk }, [chunk.buffer]);
      }
    } catch (error) {
      port2.postMessage({ error: serialiseError(error) });
    } finally {
      port2.close();
    }
  })();

  return { body: { __bunTestCloudflareStreamPort: port1 }, transferList: [port1] };
};

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
    const isStreamResponse = response.headers.get("${"MF-Op-Result-Type"}") === "ReadableStream";
    const { body: responseBody, transferList } = isStreamResponse && response.body
      ? createStreamBridge(response.body)
      : await (async () => {
          const body = await response.arrayBuffer();
          return { body, transferList: body === null ? undefined : [body] };
        })();
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
  // Bun also cannot transfer the live response ReadableStream here, so proxy
  // stream chunks over a MessagePort and reconstruct the stream in
  // receiveMessageOnPort() below.
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
    if (!response) {
      return message;
    }

    const resultType = response.headers?.["mf-op-result-type"] ?? response.headers?.["MF-Op-Result-Type"];
    if (resultType !== "ReadableStream") {
      return message;
    }

    const streamPort = response.body?.__bunTestCloudflareStreamPort;
    if (!streamPort) {
      return message;
    }

    response.body = new ReadableStream<Uint8Array>({
      start(controller) {
        streamPort.on("message", (streamMessage: any) => {
          if (streamMessage.done) {
            controller.close();
            streamPort.close();
            return;
          }
          if (streamMessage.error) {
            const error = new Error(streamMessage.error.message);
            error.name = streamMessage.error.name;
            if (streamMessage.error.stack) {
              error.stack = streamMessage.error.stack;
            }
            controller.error(error);
            streamPort.close();
            return;
          }
          controller.enqueue(streamMessage.chunk);
        });
      },
      cancel() {
        streamPort.close();
      },
    });
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
