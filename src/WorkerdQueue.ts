export type RunQueueBody<Body> = { runId: string; body: Body };

/** An envelope uses native V8 serialization so the payload can contain bytes and other RPC values. */
export const runQueueMessage = <Body>(runId: string, body: Body): RunQueueBody<Body> => ({ runId, body });

export type RunQueueOperation =
  | { method: "metrics" }
  | { method: "send"; body: unknown; options?: QueueSendOptions }
  | {
      method: "sendBatch";
      messages: Array<{ body: unknown; delaySeconds?: number; contentType?: QueueContentType }>;
      options?: QueueSendBatchOptions;
    };

export function createRunQueueBinding<Body = unknown>(
  invoke: (operation: RunQueueOperation) => Promise<unknown>,
): Queue<Body> {
  return {
    metrics: () => invoke({ method: "metrics" }) as Promise<QueueMetrics>,
    send: (body: Body, options?: QueueSendOptions) =>
      invoke({ method: "send", body, options }) as Promise<QueueSendResponse>,
    sendBatch: (messages: Iterable<MessageSendRequest<Body>>, options?: QueueSendBatchOptions) => {
      const encoded = Array.from(messages, (message) => ({
        body: message.body,
        ...(message.delaySeconds !== undefined ? { delaySeconds: message.delaySeconds } : {}),
        ...(message.contentType !== undefined ? { contentType: message.contentType } : {}),
      }));
      return invoke({ method: "sendBatch", messages: encoded, options }) as Promise<QueueSendBatchResponse>;
    },
  };
}

export async function executeRunQueueOperation(queue: Queue, runId: string, operation: RunQueueOperation) {
  if (operation.method === "metrics") return queue.metrics();
  if (operation.method === "send") {
    return queue.send(runQueueMessage(runId, operation.body), {
      ...operation.options,
      contentType: "v8",
    });
  }
  return queue.sendBatch(
    operation.messages.map((message) => ({
      ...message,
      body: runQueueMessage(runId, message.body),
      contentType: "v8",
    })),
    operation.options,
  );
}
