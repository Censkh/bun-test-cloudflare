import type { TestHarness, TestHarnessOptions, WorkerHandle } from "wrangler";
import { createTestHarness } from "wrangler";

type WorkerInput = TestHarnessOptions["workers"][number];

export type TypeToken<T> = {
  readonly __type?: T;
};

export const typeToken = <T>(): TypeToken<T> => ({});

export type CloudflareWorkerConfig<TBindings = Record<string, any>> = WorkerInput & {
  bindings?: TypeToken<TBindings>;
  name?: string;
};

export type CloudflareWorkerMap<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  [TKey in keyof TWorkers]: WorkerHandle<WorkerBindings<TWorkers[TKey]>>;
};

export type CloudflareHarnessConfig<TWorkers extends Record<string, CloudflareWorkerConfig>> = Omit<
  TestHarnessOptions,
  "workers"
> & {
  workers: TWorkers;
};

export type CloudflareHarness<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  close: TestHarness["close"];
  get server(): TestHarness;
  listen: TestHarness["listen"];
  run<TResult>(
    callback: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<TResult> | TResult,
  ): Promise<TResult>;
  workers(): CloudflareWorkerMap<TWorkers>;
};

const toWorkerInput = (worker: CloudflareWorkerConfig): WorkerInput => {
  const { bindings: _bindings, name: _name, ...input } = worker;
  return input;
};

type WorkerBindings<TWorker> = TWorker extends { bindings?: TypeToken<infer TBindings> }
  ? TBindings
  : Record<string, any>;

const logServerLogs = (server: TestHarness) => {
  const logs = server.getLogs();
  if (logs.length === 0) return;

  console.error("[bun-test-cloudflare] Worker runtime logs before failure:");
  for (const log of logs) {
    console.error(JSON.stringify(log));
  }
};

export const createCloudflareHarness = <const TWorkers extends Record<string, CloudflareWorkerConfig>>(
  config: CloudflareHarnessConfig<TWorkers>,
): CloudflareHarness<TWorkers> => {
  const workerEntries = Object.entries(config.workers) as Array<[keyof TWorkers, CloudflareWorkerConfig]>;
  const server = createTestHarness({
    ...config,
    workers: workerEntries.map(([, worker]) => toWorkerInput(worker)),
  });

  const getWorkers = () =>
    Object.fromEntries(
      workerEntries.map(([key, worker]) => [key, server.getWorker(worker.name ?? String(key))]),
    ) as CloudflareWorkerMap<TWorkers>;

  return {
    close: () => server.close(),
    get server() {
      return server;
    },
    listen: () => server.listen(),
    async run(callback) {
      try {
        await server.listen();
        return await callback(getWorkers(), server);
      } catch (error) {
        logServerLogs(server);
        throw error;
      } finally {
        await server.close();
      }
    },
    workers: getWorkers,
  };
};
