import { onTestFinished } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { TestHarness, TestHarnessOptions } from "wrangler";
import { createTestHarness } from "wrangler";
import { getCapturedRuntimeCaches, runWithCloudflareCaches } from "./CacheBridge";
import type { CloudflareHarnessConfig, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
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

const sleep = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));
const serverLifecycleLockTimeoutMs = 60_000;

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error;

const isProcessAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type ServerLifecycleLockOwner = {
  operation: string;
  pid: number;
  startedAt: number;
};

const serverLifecycleDir = () => path.join(process.cwd(), "node_modules/.btcf/server-lifecycle");
const serverLifecycleLockPath = (filename: string) => path.join(serverLifecycleDir(), filename);

const readServerLifecycleLockOwner = (lockPath: string): ServerLifecycleLockOwner | undefined => {
  try {
    return JSON.parse(readFileSync(lockPath, "utf8")) as ServerLifecycleLockOwner;
  } catch {
    return undefined;
  }
};

const removeDeadServerLifecycleLock = (lockPath: string) => {
  const owner = readServerLifecycleLockOwner(lockPath);
  if (!owner) return;

  if (isProcessAlive(owner.pid)) return;

  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
};

const releaseServerLifecycleLock = (lockPath: string) => {
  try {
    unlinkSync(lockPath);
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
};

const acquireServerLifecycleLock = async (filename: string, operation: string) => {
  const lockPath = serverLifecycleLockPath(filename);
  mkdirSync(serverLifecycleDir(), { recursive: true });
  const start = Date.now();

  while (Date.now() - start <= serverLifecycleLockTimeoutMs) {
    try {
      const lockFile = openSync(lockPath, "wx");
      writeFileSync(lockFile, JSON.stringify({ operation, pid: process.pid, startedAt: Date.now() }));
      closeSync(lockFile);
      return () => releaseServerLifecycleLock(lockPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }
      removeDeadServerLifecycleLock(lockPath);
      await sleep(25);
    }
  }

  const owner = readServerLifecycleLockOwner(lockPath);
  throw new Error(
    `Timed out waiting for Wrangler server lifecycle lock: ${lockPath}${
      owner ? ` owned by pid ${owner.pid} (${owner.operation})` : ""
    }`,
  );
};

const runWithServerLifecycle = async <TResult>(
  operation: "close" | "listen",
  callback: () => Promise<TResult> | TResult,
) => {
  // Miniflare starts workerd through child-process stdio/control pipes. Under
  // Bun's parallel test workers, overlapping starts and closes can break a
  // different workerd's startup pipe, so this gate must be filesystem-backed
  // rather than process-local.
  const release = await acquireServerLifecycleLock("lifecycle.lock", operation);
  try {
    return await callback();
  } finally {
    release();
  }
};

const runWithServerListen = async <TResult>(callback: () => Promise<TResult> | TResult) =>
  runWithServerLifecycle("listen", callback);

const runWithServerClose = async <TResult>(callback: () => Promise<TResult> | TResult) =>
  runWithServerLifecycle("close", callback);

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
    const bunRuntime = (globalThis as typeof globalThis & { Bun?: { gc?: (force?: boolean) => void } }).Bun;
    // Bun can retain Miniflare platform-proxy resources after close; forcing
    // collection prevents those stale resources affecting the next harness run.
    bunRuntime?.gc?.(true);

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
          return runWithServerListen(() => this.#server.listen());
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
    this.#logStream.flush();
    this.#logStream.stop();
    await runWithServerClose(() => closeServer(this.#server));
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
