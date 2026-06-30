import { mock } from "bun:test";
import type * as WorkerThreads from "node:worker_threads";

const synchronousFetcherStreamTransferCode = `
    const responseBody = response.headers.get("${"MF-Op-Result-Type"}") === "ReadableStream"
      ? response.body
      : await response.arrayBuffer();
    const transferList = responseBody === null ? undefined : [responseBody];`;

const synchronousFetcherBufferedStreamCode = `
    const responseBody = await response.arrayBuffer();
    const transferList = responseBody === null ? undefined : [responseBody];`;

const patchSynchronousFetcherWorkerScript = (script: string) => {
  if (!script.includes(synchronousFetcherStreamTransferCode)) {
    return script;
  }

  return script.replace(synchronousFetcherStreamTransferCode, synchronousFetcherBufferedStreamCode);
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
