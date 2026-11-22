import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export {
  clearRunCaches,
  createRunCacheStorage,
  executeRunCacheOperation,
  type RunCacheOperation,
} from "./WorkerdCache";
export {
  clearD1Database,
  createRunD1Binding,
  executeRunD1Operation,
  type RunD1Binding,
  type RunD1Operation,
} from "./WorkerdD1";
export {
  clearRunDurableObjects,
  createRunDurableObjectNamespace,
  encodeScopedObjectName,
  executeRunDurableObjectOperation,
  parseRunObjectIdentity,
  type RunDurableObjectOperation,
  type RunDurableObjectTarget,
  runObjectName,
} from "./WorkerdDurableObject";
export { clearKVNamespace, createRunKVBinding, executeRunKVOperation, type RunKVOperation } from "./WorkerdKV";
export {
  createRunQueueBinding,
  executeRunQueueOperation,
  type RunQueueBody,
  type RunQueueOperation,
  runQueueMessage,
} from "./WorkerdQueue";

import type { RunQueueBody } from "./WorkerdQueue";

export {
  clearR2Bucket,
  createRunR2Binding,
  type EncodedR2Object,
  executeRunR2Operation,
  type RunR2Binding,
  type RunR2Operation,
} from "./WorkerdR2";
export {
  createRunRateLimitBinding,
  executeRunRateLimitOperation,
  type RunRateLimitOperation,
} from "./WorkerdRateLimit";

export {
  createRunWorkflowBinding,
  executeRunWorkflowOperation,
  type RunWorkflowOperation,
  type RunWorkflowParams,
  terminateRunWorkflows,
  unscopeRunWorkflowInstanceId,
} from "./WorkerdWorkflow";
export type RunOperation = { name: string; args: unknown[] };
export const runEnded = "BUN_TEST_CLOUDFLARE_RUN_ENDED";

export abstract class RunBindingProxy<Env> extends DurableObject<Env> {
  #active: string | undefined;
  #lastActive: string | undefined;
  #rotation = Promise.resolve();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#active = await ctx.storage.get<string>("active");
      this.#lastActive = this.#active;
    });
  }

  /** Run IDs must never be reused. A failed reset leaves admission closed. */
  activate(runId: string): Promise<void> {
    const rotate = async () => {
      const retiredRunId = this.#lastActive;
      this.#active = undefined;
      await this.ctx.storage.delete("active");
      await Promise.allSettled(this.#pending);
      await this.resetBindings(retiredRunId);
      this.#lastActive = undefined;
      await this.ctx.storage.put("active", runId);
      this.#active = runId;
      this.#lastActive = runId;
    };
    const next = this.#rotation.then(rotate);
    this.#rotation = next.catch(() => {});
    return next;
  }

  /**
   * Closes admission for the active run, drains in-flight binding operations, and resets storage
   * in the background so the slot is already clean by the time the next rotation activates it.
   */
  retire(): Promise<void> {
    let retiredRunId: string | undefined;
    const close = async () => {
      retiredRunId = this.#lastActive;
      this.#active = undefined;
      await this.ctx.storage.delete("active");
      await Promise.allSettled(this.#pending);
    };
    const closed = this.#rotation.then(close);
    const reset = closed.then(async () => {
      if (retiredRunId !== undefined) {
        await this.resetBindings(retiredRunId);
        this.#lastActive = undefined;
      }
    });
    this.#rotation = reset.catch(() => {});
    this.ctx.waitUntil(this.#rotation);
    return closed;
  }

  isActive(runId: string): boolean {
    return this.#active !== undefined && this.#active === runId;
  }

  async invoke(runId: string, operation: RunOperation): Promise<unknown> {
    if (!this.isActive(runId)) throw new Error(runEnded);
    const pending = this.perform(operation, runId);
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }

  // Adapters must finish or await every side effect before resolving and never expose raw mutable
  // bindings. Dynamic Workers receive only the capability below.
  protected abstract perform(operation: RunOperation, runId: string): Promise<unknown>;
  protected abstract resetBindings(retiredRunId?: string): Promise<void>;
}

type RunCapabilityProps = {
  proxy: DurableObjectStub<RunBindingProxy<unknown> & { getRuntimeVars(workerName: string): unknown }>;
};

/**
 * A slot's bindings, for the Worker isolates that serve its runs one after another: each call names
 * its run, which the slot refuses once it is retired, so a stale call from an earlier run can't
 * reach the current one's state.
 */
export class RunBindingCapability extends WorkerEntrypoint<unknown, RunCapabilityProps> {
  invoke(runId: string, name: string, ...args: unknown[]) {
    return this.ctx.props.proxy.invoke(runId, { name, args });
  }

  /** The run's vars for a Worker, over its own: what the harness, or the run's variant, gave it. */
  async vars(runId: string, workerName: string) {
    const { proxy } = this.ctx.props;
    if (!(await proxy.isActive(runId))) throw new Error(runEnded);
    return proxy.getRuntimeVars(workerName);
  }
}

export const loadRunWorker = (
  loader: WorkerLoader,
  runId: string,
  workerName: string,
  code: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>,
) => loader.get(JSON.stringify([runId, workerName]), code);

/** Drop retired messages individually, even when the broker delivers mixed generations. */
export const dispatchRunQueue = async <Body>(
  batch: MessageBatch<RunQueueBody<Body>>,
  isActive: (runId: string) => Promise<boolean>,
  handle: (runId: string, batch: MessageBatch<Body>) => Promise<void>,
) => {
  const runs = new Map<string, Message<Body>[]>();
  for (const message of batch.messages) {
    const { runId, body } = message.body;
    let messages = runs.get(runId);
    if (!messages) runs.set(runId, (messages = []));
    messages.push({
      id: message.id,
      timestamp: message.timestamp,
      attempts: message.attempts,
      body,
      ack: () => message.ack(),
      retry: (options) => message.retry(options),
    });
  }
  for (const [runId, messages] of runs) {
    const scopedBatch: MessageBatch<Body> = {
      queue: batch.queue,
      metadata: batch.metadata,
      messages,
      ackAll() {
        for (const message of messages) message.ack();
      },
      retryAll(options) {
        for (const message of messages) message.retry(options);
      },
    };
    if (await isActive(runId)) await handle(runId, scopedBatch);
    else scopedBatch.ackAll();
  }
};

const alarmRunKey = "__bun_test_cloudflare_alarm_run";

/** Use an object named by runObjectName() so an old alarm can never acquire a new owner. */
export const setRunAlarm = (storage: DurableObjectStorage, runId: string, when: number | Date) =>
  storage.transaction(async (transaction) => {
    const owner = await transaction.get<string>(alarmRunKey);
    if (owner !== undefined && owner !== runId) throw new Error(runEnded);
    await transaction.put(alarmRunKey, runId);
    await transaction.setAlarm(when);
  });

export const getRunAlarmOwner = (storage: DurableObjectStorage) => storage.get<string>(alarmRunKey);
