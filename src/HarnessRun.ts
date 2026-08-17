import { onTestFinished } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestHarness, TestHarnessOptions } from "wrangler";
import { createTestHarness } from "wrangler";
import { getCapturedRuntimeCaches, runWithCloudflareCaches } from "./CacheBridge";
import { drainHarnessRun } from "./HarnessRunTeardown";
import type { CloudflareHarnessConfig, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
import { getObservedBrowserRenderingLaunchCount } from "./patches/BrowserRenderingPatch";
import {
  type CapturedDevEnv,
  createAsyncOperationTracker,
  devEnvCaptureContext,
  disposeCapturedMiniflareRuntimes,
  platformProxyDispatchContext,
  runWithTestHarnessPersistencePath,
} from "./wranglerPatches";

type WorkerInput = TestHarnessOptions["workers"][number];

export type PreparedWorkerInput = {
  browserBindingName: string | undefined;
  built: boolean;
  durationMs: number;
  hasBrowserRendering: boolean;
  input: WorkerInput;
  name: string;
};

export type CloudflareHarnessRunContext<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  server: TestHarness;
  workers: CloudflareWorkerMap<TWorkers>;
};

type HarnessRunOptions<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  events: CloudflareHarnessConfig<TWorkers>["events"];
  hasBrowserRendering: boolean;
  preparedWorkers: PreparedWorkerInput[];
  testHarnessOptions: Omit<TestHarnessOptions, "workers"> & { workers: WorkerInput[] };
  workerEntries: Array<[keyof TWorkers, CloudflareWorkerConfig]>;
};

const harnessRunContext = new AsyncLocalStorage<CloudflareHarnessRunContext<any>>();
const timingOrigin = performance.now();

const logTiming = (label: string, startedAt: number) => {
  if (process.env.BUN_TEST_CLOUDFLARE_TIMINGS !== "1") {
    return;
  }

  const now = performance.now();
  process.stderr.write(
    `[bun-test-cloudflare] +${(now - timingOrigin).toFixed(1)}ms ${label}: ${(now - startedAt).toFixed(1)}ms\n`,
  );
};

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
  const waitUntilFailures: string[] = [];

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
      const message = "message" in log ? log.message : JSON.stringify(log);
      if (log.level === "error" && /\bwait\s*until\b/i.test(message)) {
        waitUntilFailures.push(message);
      }
    }
  };

  const interval = setInterval(flush, 25);

  return {
    assertNoWaitUntilFailures: () => {
      if (waitUntilFailures.length === 0) return;

      throw new Error(
        `Worker waitUntil promise rejection${waitUntilFailures.length === 1 ? "" : "s"}:\n${waitUntilFailures.join("\n")}`,
      );
    },
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
    return error;
  }
};

const debugCleanup = async <T>(step: string, task: () => Promise<T>) => {
  if (!process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
    return task();
  }

  const start = Date.now();
  console.error(`[bun-test-cloudflare] cleanup:${step}:start`);
  try {
    return await task();
  } finally {
    console.error(`[bun-test-cloudflare] cleanup:${step}:end ${Date.now() - start}ms`);
  }
};

const debugCleanupSync = <T>(step: string, task: () => T) => {
  if (!process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
    return task();
  }

  const start = Date.now();
  console.error(`[bun-test-cloudflare] cleanup:${step}:start`);
  try {
    return task();
  } finally {
    console.error(`[bun-test-cloudflare] cleanup:${step}:end ${Date.now() - start}ms`);
  }
};

type BrowserSession = {
  sessionId?: unknown;
};

const getBrowserRenderingSessions = async (binding: Fetcher) => {
  const response = await binding.fetch("https://bun-test-cloudflare.invalid/v1/sessions");
  if (!response.ok) {
    return [];
  }

  const body = (await response.json()) as { sessions?: BrowserSession[] };
  return Array.isArray(body.sessions) ? body.sessions : [];
};

const closeBrowserRenderingSession = async (binding: Fetcher, sessionId: string) => {
  const url = `https://bun-test-cloudflare.invalid/v1/devtools/browser/${encodeURIComponent(sessionId)}`;
  const response = await binding.fetch(url, { method: "DELETE" });
  if (!response.ok && response.status !== 404 && response.status !== 410) {
    throw new Error(`Failed closing Browser Rendering session ${sessionId}: HTTP ${response.status}`);
  }
};

export class HarnessRun<TWorkers extends Record<string, CloudflareWorkerConfig>> {
  readonly #capturedDevEnvs: CapturedDevEnv[] = [];
  readonly #initialBrowserRenderingLaunchCount = getObservedBrowserRenderingLaunchCount();
  readonly #platformProxyDispatches = createAsyncOperationTracker();
  readonly #server: TestHarness;
  readonly #logStream: ReturnType<typeof streamServerLogs>;
  readonly #storageRoot = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-"));
  #cacheStorage: CacheStorage | undefined;
  #closed = false;
  #startPromise: Promise<void> | undefined;
  #storageGeneration = 0;
  #workers: CloudflareWorkerMap<TWorkers> | undefined;

  readonly #timingLabel: string;

  constructor(private readonly options: HarnessRunOptions<TWorkers>) {
    this.#timingLabel = options.preparedWorkers.map((worker) => worker.name).join(",");
    this.#server = createTestHarness(options.testHarnessOptions);
    this.#logStream = streamServerLogs(this.#server);
  }

  start() {
    this.#startPromise ??= (async () => {
      const startedAt = performance.now();
      const listenStartedAt = performance.now();
      await this.#runWithFreshStorage(() =>
        devEnvCaptureContext.run(this.#capturedDevEnvs, () => this.#server.listen()),
      );
      logTiming(`${this.#timingLabel} start:listen`, listenStartedAt);

      const cachesStartedAt = performance.now();
      this.#cacheStorage = await getCapturedRuntimeCaches(this.#capturedDevEnvs);
      logTiming(`${this.#timingLabel} start:caches`, cachesStartedAt);
      this.#workers = this.#getWorkers();
      logTiming(`${this.#timingLabel} start`, startedAt);
    })();

    return this.#startPromise;
  }

  async execute<TResult>(
    callback: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<TResult> | TResult,
    { closeAfterExecute = true }: { closeAfterExecute?: boolean } = {},
  ) {
    const startedAt = performance.now();
    if (closeAfterExecute) {
      onTestFinished(() => this.close());
    }

    try {
      return await platformProxyDispatchContext.run(this.#platformProxyDispatches, async () => {
        await this.start();
        const workers = this.#workers;
        if (!workers) {
          throw new Error("Cloudflare harness run failed to start");
        }
        const runCallback = () =>
          harnessRunContext.run({ server: this.#server, workers }, async () => {
            await this.options.events?.beforeRun?.(workers, this.#server);
            return callback(workers, this.#server);
          });

        const callbackStartedAt = performance.now();
        try {
          return await (this.#cacheStorage ? runWithCloudflareCaches(this.#cacheStorage, runCallback) : runCallback());
        } finally {
          logTiming(`${this.#timingLabel} execute:callback`, callbackStartedAt);
        }
      });
    } finally {
      if (closeAfterExecute) {
        await this.close();
      }
      logTiming(`${this.#timingLabel} execute`, startedAt);
    }
  }

  async assertUsable() {
    const startedAt = performance.now();
    await this.start();
    if (!this.#workers) {
      throw new Error("Cloudflare harness run failed to start");
    }

    await Promise.all(Object.values(this.#workers).map((worker) => worker.getEnv()));
    logTiming(`${this.#timingLabel} assert-usable`, startedAt);
  }

  async resetForReuse() {
    const startedAt = performance.now();
    if (this.#closed) {
      throw new Error("Cloudflare harness run is closed");
    }

    await drainHarnessRun({
      devEnvs: this.#capturedDevEnvs,
      drainBrowserRendering: this.options.hasBrowserRendering,
      platformProxyDispatches: this.#platformProxyDispatches,
    });
    await this.#closeActiveBrowserRenderingSessions();
    this.#logStream.flush();
    await this.#reloadConfiguration();
    this.#server.clearLogs();
    logTiming(`${this.#timingLabel} reset`, startedAt);
  }

  flushLogs() {
    this.#logStream.flush();
  }

  async close() {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] draining runtime messages");
    }
    await debugCleanup("drain-harness-before-browser-close", () =>
      drainHarnessRun({
        devEnvs: this.#capturedDevEnvs,
        drainBrowserRendering: this.options.hasBrowserRendering,
        platformProxyDispatches: this.#platformProxyDispatches,
      }),
    );
    await debugCleanup("close-active-browser-sessions", () => this.#closeActiveBrowserRenderingSessions());
    await debugCleanup("drain-harness-after-browser-close", () =>
      drainHarnessRun({
        devEnvs: this.#capturedDevEnvs,
        drainBrowserRendering: this.options.hasBrowserRendering,
        platformProxyDispatches: this.#platformProxyDispatches,
      }),
    );
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] drained harness run");
    }
    debugCleanupSync("flush-log-stream", () => this.#logStream.flush());
    debugCleanupSync("stop-log-stream", () => this.#logStream.stop());
    try {
      const closeError = await debugCleanup("close-server", () => closeServer(this.#server));
      await debugCleanup("dispose-miniflare-runtimes", () => disposeCapturedMiniflareRuntimes(this.#capturedDevEnvs));
      if (closeError) {
        throw closeError;
      }
    } finally {
      rmSync(this.#storageRoot, { force: true, recursive: true });
      logTiming(`${this.#timingLabel} close`, startedAt);
    }
    this.#logStream.assertNoWaitUntilFailures();
  }

  async #reloadConfiguration() {
    await this.#runWithFreshStorage(() => this.#server.update((currentOptions) => currentOptions));
    this.#cacheStorage = await getCapturedRuntimeCaches(this.#capturedDevEnvs);
    this.#workers = this.#getWorkers();
  }

  #runWithFreshStorage<TResult>(callback: () => TResult) {
    const persistencePath = path.join(this.#storageRoot, String(this.#storageGeneration++));
    mkdirSync(persistencePath, { recursive: true });
    return runWithTestHarnessPersistencePath(persistencePath, callback);
  }

  #getWorkers() {
    return Object.fromEntries(
      this.options.workerEntries.map(([key, worker]) => {
        const handle = this.#server.getWorker(worker.name ?? String(key));
        return [key, handle];
      }),
    ) as unknown as CloudflareWorkerMap<TWorkers>;
  }

  async #closeActiveBrowserRenderingSessions() {
    if (!this.options.hasBrowserRendering || !this.#workers) {
      return;
    }
    if (getObservedBrowserRenderingLaunchCount() === this.#initialBrowserRenderingLaunchCount) {
      return;
    }

    const workerEntriesByName = new Map(
      this.options.workerEntries.map(([key, worker]) => [worker.name ?? String(key), key]),
    );

    for (const preparedWorker of this.options.preparedWorkers) {
      const browserBindingName = preparedWorker.browserBindingName;
      if (!browserBindingName) {
        continue;
      }

      const workerKey = workerEntriesByName.get(preparedWorker.name);
      if (!workerKey) {
        continue;
      }

      const worker = this.#workers[workerKey];
      if (!worker) {
        continue;
      }

      try {
        const env = (await worker.getEnv()) as Record<string, unknown>;
        const binding = env[browserBindingName] as Fetcher | undefined;
        if (!binding || typeof binding.fetch !== "function") {
          continue;
        }

        const sessions = await getBrowserRenderingSessions(binding);
        if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP && sessions.length > 0) {
          console.error(
            `[bun-test-cloudflare] closing ${sessions.length} Browser Rendering session(s) for ${preparedWorker.name}`,
          );
        }
        await Promise.all(
          sessions.map(async (session) => {
            if (typeof session.sessionId === "string") {
              await closeBrowserRenderingSession(binding, session.sessionId);
            }
          }),
        );
      } catch (error) {
        console.error("[bun-test-cloudflare] Failed closing active Browser Rendering sessions:");
        console.error(error);
      }
    }
  }
}
