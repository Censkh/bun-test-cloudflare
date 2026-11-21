import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";

export { createRunD1Binding, executeRunD1Operation, type RunD1Binding, type RunD1Operation } from "./WorkerdD1";
export { createRunR2Binding, executeRunR2Operation, type RunR2Binding, type RunR2Operation } from "./WorkerdR2";

export type RunOperation = { name: string; args: unknown[] };
export const runEnded = "BUN_TEST_CLOUDFLARE_RUN_ENDED";

export abstract class RunBindingProxy<Env> extends DurableObject<Env> {
  #active: string | undefined;
  #rotation = Promise.resolve();
  readonly #pending = new Set<Promise<unknown>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.#active = await ctx.storage.get<string>("active");
    });
  }

  /** Run IDs must never be reused. A failed reset leaves admission closed. */
  activate(runId: string): Promise<void> {
    const rotate = async () => {
      this.#active = undefined;
      await this.ctx.storage.delete("active");
      await Promise.allSettled(this.#pending);
      await this.resetBindings();
      await this.ctx.storage.put("active", runId);
      this.#active = runId;
    };
    const next = this.#rotation.then(rotate);
    this.#rotation = next.catch(() => {});
    return next;
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
  protected abstract resetBindings(): Promise<void>;
}

type RunCapabilityProps = { runId: string; proxy: DurableObjectStub<RunBindingProxy<unknown>> };

/** The run is fixed by the supervisor; a caller cannot choose a different generation for an RPC. */
export class RunBindingCapability extends WorkerEntrypoint<unknown, RunCapabilityProps> {
  invoke(name: string, ...args: unknown[]) {
    const { runId, proxy } = this.ctx.props;
    return proxy.invoke(runId, { name, args });
  }
}

export const loadRunWorker = (
  loader: WorkerLoader,
  runId: string,
  workerName: string,
  code: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>,
) => loader.get(JSON.stringify([runId, workerName]), code);

export type RunQueueBody<Body> = { runId: string; body: Body };

/** An envelope uses native V8 serialization so the payload can contain bytes and other RPC values. */
export const runQueueMessage = <Body>(runId: string, body: Body): RunQueueBody<Body> => ({ runId, body });

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

export const runObjectName = (runId: string, name: string) => JSON.stringify([runId, name]);

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
