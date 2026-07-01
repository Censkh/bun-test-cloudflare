import { onTestFinished } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { TestHarness, TestHarnessOptions } from "wrangler";
import { createTestHarness } from "wrangler";
import { getCapturedRuntimeCaches, runWithCloudflareCaches } from "./CacheBridge";
import type { CloudflareHarnessConfig, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
import { drainBrowserRenderingLaunches } from "./patches/BrowserRenderingPatch";
import {
  type CapturedDevEnv,
  createAsyncOperationTracker,
  devEnvCaptureContext,
  drainDevEnvRuntimeMessages,
  platformProxyDispatchContext,
} from "./wranglerPatches";

type WorkerInput = TestHarnessOptions["workers"][number];

export type PreparedWorkerInput = {
  built: boolean;
  durationMs: number;
  input: WorkerInput;
  name: string;
};

export type CloudflareHarnessRunContext<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  server: TestHarness;
  workers: CloudflareWorkerMap<TWorkers>;
};

type HarnessRunOptions<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  events: CloudflareHarnessConfig<TWorkers>["events"];
  preparedWorkers: PreparedWorkerInput[];
  testHarnessOptions: Omit<TestHarnessOptions, "workers"> & { workers: WorkerInput[] };
  workerEntries: Array<[keyof TWorkers, CloudflareWorkerConfig]>;
};

const harnessRunContext = new AsyncLocalStorage<CloudflareHarnessRunContext<any>>();

export const getCloudflareHarnessRunContext = <const TWorkers extends Record<string, CloudflareWorkerConfig>>() => {
  const context = harnessRunContext.getStore();
  if (!context) {
    throw new Error("Cloudflare harness run context is not active");
  }

  return context as CloudflareHarnessRunContext<TWorkers>;
};

const streamServerLogs = (server: TestHarness) => {
  let streamedLogs = 0;
  let loggedReadError = false;

  const writeLog = (log: ReturnType<TestHarness["getLogs"]>[number]) => {
    const message = "message" in log ? log.message : JSON.stringify(log);
    if (log.level === "error") {
      console.error(message);
    } else if (log.level === "warning" || log.level === "warn") {
      console.warn(message);
    } else if (log.level === "debug") {
      console.debug(message);
    } else {
      console.log(message);
    }
  };

  const flush = () => {
    let logs: ReturnType<TestHarness["getLogs"]>;
    try {
      logs = server.getLogs();
    } catch (error) {
      if (!loggedReadError) {
        loggedReadError = true;
        console.error("[bun-test-cloudflare] Failed reading Worker runtime logs:");
        console.error(error);
      }
      return;
    }

    const pendingLogs = logs.slice(streamedLogs);
    streamedLogs = logs.length;

    for (const log of pendingLogs) {
      writeLog(log);
    }
  };

  const interval = setInterval(flush, 25);

  return {
    flush,
    stop: () => clearInterval(interval),
  };
};

const closeServer = async (server: TestHarness) => {
  try {
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] closing Wrangler test server");
    }
    await server.close();
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] closed Wrangler test server");
    }
  } catch (error) {
    console.error("[bun-test-cloudflare] Failed closing Wrangler test server:");
    console.error(error);
  }
};

export class HarnessRun<TWorkers extends Record<string, CloudflareWorkerConfig>> {
  readonly #capturedDevEnvs: CapturedDevEnv[] = [];
  readonly #platformProxyDispatches = createAsyncOperationTracker();
  readonly #server: TestHarness;
  readonly #logStream: ReturnType<typeof streamServerLogs>;
  #closed = false;

  constructor(private readonly options: HarnessRunOptions<TWorkers>) {
    this.#server = createTestHarness(options.testHarnessOptions);
    this.#logStream = streamServerLogs(this.#server);
  }

  async execute<TResult>(
    callback: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<TResult> | TResult,
  ) {
    onTestFinished(() => this.close());

    try {
      return await platformProxyDispatchContext.run(this.#platformProxyDispatches, async () => {
        await devEnvCaptureContext.run(this.#capturedDevEnvs, () => {
          return this.#server.listen();
        });
        const cacheStorage = await getCapturedRuntimeCaches(this.#capturedDevEnvs);
        const workers = this.#getWorkers();
        const runCallback = () =>
          harnessRunContext.run({ server: this.#server, workers }, async () => {
            await this.options.events?.beforeRun?.(workers, this.#server);
            return callback(workers, this.#server);
          });

        return await (cacheStorage ? runWithCloudflareCaches(cacheStorage, runCallback) : runCallback());
      });
    } finally {
      await this.close();
    }
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] draining runtime messages");
    }
    await drainDevEnvRuntimeMessages(this.#capturedDevEnvs);
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] drained runtime messages");
      console.error("[bun-test-cloudflare] draining platform proxy dispatches");
    }
    await this.#platformProxyDispatches.drain();
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] drained platform proxy dispatches");
    }
    // Platform proxy dispatch completion can enqueue follow-up runtime work.
    // Drain runtime messages again before closing the shared Wrangler server.
    await drainDevEnvRuntimeMessages(this.#capturedDevEnvs);
    await drainBrowserRenderingLaunches();
    this.#logStream.flush();
    this.#logStream.stop();
    await closeServer(this.#server);
  }

  #getWorkers() {
    return Object.fromEntries(
      this.options.workerEntries.map(([key, worker]) => {
        const handle = this.#server.getWorker(worker.name ?? String(key));
        return [key, handle];
      }),
    ) as CloudflareWorkerMap<TWorkers>;
  }
}
