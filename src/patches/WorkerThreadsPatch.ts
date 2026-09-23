import { mock } from "bun:test";
import type * as WorkerThreads from "node:worker_threads";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";

const synchronousFetcherMessageHandlerStart = `port.addEventListener("message", async (event) => {`;
const synchronousFetcherRequiredCode = `headers["${"MF-Op-Sync"}"] = "true";`;

type WorkerThreadsPatchOptions = {
  fifo: boolean;
  streamBridge: boolean;
  noTimeouts: boolean;
};

const getSynchronousFetcherStreamBridgeBootstrap = ({ streamBridge }: WorkerThreadsPatchOptions) =>
  streamBridge
    ? `
const { MessageChannel: __bunTestCloudflareMessageChannel, MessagePort: __bunTestCloudflareMessagePort } = require("worker_threads");
const __bunTestCloudflarePostMessage = __bunTestCloudflareMessagePort.prototype.postMessage;
const __bunTestCloudflareSerialiseError = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  name: error instanceof Error ? error.name : "Error",
  stack: error instanceof Error ? error.stack : undefined,
});
const __bunTestCloudflareTransferChunk = (chunk) => {
  if (chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength) {
    return chunk;
  }
  return new Uint8Array(chunk);
};
__bunTestCloudflareMessagePort.prototype.postMessage = function (value, transferList) {
  const response = value?.response;
  const resultType = response?.headers?.["mf-op-result-type"] ?? response?.headers?.["MF-Op-Result-Type"];
  if (resultType !== "ReadableStream" || !(response.body instanceof ReadableStream)) {
    return __bunTestCloudflarePostMessage.call(this, value, transferList);
  }

  const { port1, port2 } = new __bunTestCloudflareMessageChannel();
  const reader = response.body.getReader();
  // Keep the sender alive until the receiver consumes the terminal message.
  // Closing sooner can drop queued messages on Bun.
  port2.once("message", () => port2.close());

  (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          port2.postMessage({ done: true });
          break;
        }
        const chunk = __bunTestCloudflareTransferChunk(value);
        port2.postMessage({ chunk }, [chunk.buffer]);
      }
    } catch (error) {
      port2.postMessage({ error: __bunTestCloudflareSerialiseError(error) });
    } finally {
      reader.releaseLock();
    }
  })();

  return __bunTestCloudflarePostMessage.call(
    this,
    { ...value, response: { ...response, body: { __bunTestCloudflareStreamPort: port1 } } },
    [port1],
  );
};`
    : "";

export const patchSynchronousFetcherWorkerScript = (
  script: string,
  options: WorkerThreadsPatchOptions = {
    fifo: true,
    streamBridge: true,
    noTimeouts: true,
  },
) => {
  const startIndex = script.indexOf(synchronousFetcherMessageHandlerStart);
  if (startIndex < 0 || !script.includes(synchronousFetcherRequiredCode)) {
    return script;
  }

  // Preserve Miniflare's handler and its private wake-up protocol. Bun cannot
  // transfer its live response ReadableStream, so intercept only that message
  // and bridge its chunks through a MessagePort.
  return `${script.slice(0, startIndex)}${getSynchronousFetcherStreamBridgeBootstrap(options)}${script.slice(startIndex)}`;
};

export const installWorkerThreadsPatch = () => {
  const patchOptions = {
    fifo: shouldInstallCompatibilityPatch("worker-threads-fifo"),
    streamBridge: shouldInstallCompatibilityPatch("worker-threads-stream-bridge"),
    noTimeouts: shouldInstallCompatibilityPatch("worker-threads-no-timeouts"),
  };
  const workerThreads = require("node:worker_threads") as typeof WorkerThreads;
  type PortMessage = NonNullable<ReturnType<typeof workerThreads.receiveMessageOnPort>>;

  const bufferedPortMessages = new WeakMap<WorkerThreads.MessagePort, Map<number, PortMessage>>();
  const expectedPortMessageIds = new WeakMap<WorkerThreads.MessagePort, number>();

  const sleepSync = (durationMs: number) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
  };

  const getBufferedMessages = (port: WorkerThreads.MessagePort) => {
    let messages = bufferedPortMessages.get(port);
    if (!messages) {
      messages = new Map();
      bufferedPortMessages.set(port, messages);
    }
    return messages;
  };

  const getMessageId = (message: PortMessage | undefined) => {
    const id = message?.message?.id;
    return typeof id === "number" ? id : undefined;
  };

  const normalizeMessage = (message: PortMessage | undefined) => {
    if (!patchOptions.streamBridge) {
      return message;
    }

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
            streamPort.postMessage({ acknowledged: true });
            return;
          }
          if (streamMessage.error) {
            const error = new Error(streamMessage.error.message);
            error.name = streamMessage.error.name;
            if (streamMessage.error.stack) {
              error.stack = streamMessage.error.stack;
            }
            controller.error(error);
            streamPort.postMessage({ acknowledged: true });
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

  class WorkerThreadsCompatWorker extends workerThreads.Worker {
    constructor(filename: string | URL, options?: WorkerThreads.WorkerOptions) {
      super(
        typeof filename === "string" && options?.eval
          ? patchSynchronousFetcherWorkerScript(filename, patchOptions)
          : filename,
        options,
      );
    }
  }

  if (patchOptions.fifo) {
    const originalMessagePortPostMessage = workerThreads.MessagePort.prototype.postMessage;
    workerThreads.MessagePort.prototype.postMessage = function bunTestCloudflarePostMessage(
      this: WorkerThreads.MessagePort,
      ...args: Parameters<WorkerThreads.MessagePort["postMessage"]>
    ) {
      const [value] = args;
      if (
        typeof value?.id === "number" &&
        typeof value?.url === "string" &&
        typeof value?.method === "string" &&
        value?.headers &&
        typeof value.headers === "object"
      ) {
        expectedPortMessageIds.set(this, value.id);
      }
      return originalMessagePortPostMessage.apply(this, args as any);
    } as WorkerThreads.MessagePort["postMessage"];
  }

  const originalReceiveMessageOnPort = workerThreads.receiveMessageOnPort;
  const receiveMessageOnPort = (port: WorkerThreads.MessagePort) => {
    const expectedId = patchOptions.fifo ? expectedPortMessageIds.get(port) : undefined;
    if (expectedId !== undefined) {
      const bufferedMessages = getBufferedMessages(port);
      const bufferedMessage = bufferedMessages.get(expectedId);
      if (bufferedMessage) {
        bufferedMessages.delete(expectedId);
        expectedPortMessageIds.delete(port);
        return normalizeMessage(bufferedMessage);
      }

      const start = Date.now();
      while (Date.now() - start < 5_000) {
        const message = originalReceiveMessageOnPort(port);
        const messageId = getMessageId(message);
        if (messageId === expectedId) {
          expectedPortMessageIds.delete(port);
          return normalizeMessage(message);
        }
        if (messageId !== undefined && message) {
          bufferedMessages.set(messageId, message);
        } else if (message) {
          return message;
        } else {
          sleepSync(1);
        }
      }
    }

    const message = originalReceiveMessageOnPort(port);
    return normalizeMessage(message);
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
