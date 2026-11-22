import { onTestFinished } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestHarness, TestHarnessOptions } from "wrangler";
import { createTestHarness } from "wrangler";
import { getCapturedRuntimeCaches, runWithCloudflareCaches } from "./CacheBridge";
import {
  activateFencedSlot,
  configureFencedRun,
  createFencedBunCacheStorage,
  createFencedWorkerHandle,
  retireFencedSlot,
} from "./FencedEnvBridge";
import type { FencedWorkerSlots } from "./FencedWorkerSlots";
import { drainHarnessRun } from "./HarnessRunTeardown";
import type { CloudflareHarnessConfig, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
import { getObservedBrowserRenderingLaunchCount } from "./patches/BrowserRenderingPatch";
import { installWorkerdChildProcessPatch } from "./patches/WorkerdChildProcessPatch";
import { RunFence } from "./RunFence";
import type { RunVariant } from "./ServerOrchestrator";
import {
  createRuntimeCrashMonitor,
  runWithWorkerdProcessOwner,
  type WorkerRuntimeCrashError,
} from "./WorkerRuntimeCrash";
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
  prebuiltInput?: WorkerInput;
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
  fencedSlots?: FencedWorkerSlots;
  hasBrowserRendering: boolean;
  preparedWorkers: PreparedWorkerInput[];
  testHarnessOptions: Omit<TestHarnessOptions, "workers"> & { workers: WorkerInput[] };
  workerEntries: Array<[keyof TWorkers, CloudflareWorkerConfig]>;
};

// Crash detection needs the spawn hook even when the setup preload isn't used.
installWorkerdChildProcessPatch();

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

const isMissingMiniflareDispatcherClose = (error: unknown) =>
  error instanceof TypeError &&
  error.message.includes("runtimeDispatcher") &&
  error.message.includes("close is not a function");

export const getCloudflareHarnessRunContext = <const TWorkers extends Record<string, CloudflareWorkerConfig>>() => {
  const context = harnessRunContext.getStore();
  if (!context) {
    throw new Error("Cloudflare harness run context is not active");
  }

  return context as CloudflareHarnessRunContext<TWorkers>;
};

export const runInHarnessContext = <TWorkers extends Record<string, CloudflareWorkerConfig>, TResult>(
  context: CloudflareHarnessRunContext<TWorkers>,
  callback: () => TResult,
) => harnessRunContext.run(context, callback);

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
    // Each failure is reported once, so a shared lease fails only the run that caused it.
    assertNoWaitUntilFailures: () => {
      if (waitUntilFailures.length === 0) return;

      const failures = waitUntilFailures.splice(0);
      throw new Error(`Worker waitUntil promise rejection${failures.length === 1 ? "" : "s"}:\n${failures.join("\n")}`);
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
  readonly #runtime = createRuntimeCrashMonitor();
  readonly #storageRoot = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-"));
  #activeWorkerSlot = 0;
  #fence = new RunFence();
  #fencedRunCounter = 0;
  #fencedRunId = "";
  // The vars the run taking the active slot set for itself over its Workers' (`configure`).
  #variantVars: Record<string, Record<string, unknown>> = {};
  #cacheStorage: CacheStorage | undefined;
  #closed = false;
  #startPromise: Promise<void> | undefined;
  #storageGeneration = 0;
  #context: CloudflareHarnessRunContext<TWorkers> | undefined;

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
      await this.#untilRuntimeCrash(
        this.#runWithFreshStorage(() =>
          devEnvCaptureContext.run(this.#capturedDevEnvs, () =>
            runWithWorkerdProcessOwner(this.#runtime, () => this.#server.listen()),
          ),
        ),
      );
      logTiming(`${this.#timingLabel} start:listen`, listenStartedAt);

      if (this.options.fencedSlots) {
        const activateStartedAt = performance.now();
        this.#fencedRunId = `run-${++this.#fencedRunCounter}`;
        this.#variantVars = {};
        const supervisor = this.#server.getWorker(this.options.fencedSlots.slotSupervisorNames[this.#activeWorkerSlot]);
        await this.#untilRuntimeCrash(
          activateFencedSlot(
            supervisor,
            this.options.fencedSlots.secret,
            this.#fencedRunId,
            this.#readLiveWorkerVars(),
          ),
        );
        logTiming(`${this.#timingLabel} start:activate`, activateStartedAt);
      }

      this.#context = this.#createContext();
      const cachesStartedAt = performance.now();
      this.#cacheStorage = await this.#getCacheStorage();
      logTiming(`${this.#timingLabel} start:caches`, cachesStartedAt);
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
        await this.#untilRuntimeCrash(this.start());
        const context = this.#context;
        if (!context) {
          throw new Error("Cloudflare harness run failed to start");
        }
        const { server, workers } = context;
        const runCallback = () =>
          harnessRunContext.run(context, async () => {
            await this.options.events?.beforeRun?.(workers, server);
            return callback(workers, server);
          });

        const callbackStartedAt = performance.now();
        try {
          return await this.#untilRuntimeCrash(
            this.#cacheStorage ? runWithCloudflareCaches(this.#cacheStorage, runCallback) : runCallback(),
          );
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
    await this.#untilRuntimeCrash(this.start());
    if (!this.#context) {
      throw new Error("Cloudflare harness run failed to start");
    }

    await this.#untilRuntimeCrash(Promise.all(Object.values(this.#context.workers).map((worker) => worker.getEnv())));
    logTiming(`${this.#timingLabel} assert-usable`, startedAt);
  }

  canRotateWorkerSlotForReuse() {
    return this.options.fencedSlots !== undefined;
  }

  async resetForReuse() {
    const startedAt = performance.now();
    if (this.#closed) {
      throw new Error("Cloudflare harness run is closed");
    }

    await this.#untilRuntimeCrash(this.#fence.retire());
    if (this.options.fencedSlots) {
      const slotStartedAt = performance.now();
      const { secret, slotSupervisorNames } = this.options.fencedSlots;
      const previousSupervisor = this.#server.getWorker(slotSupervisorNames[this.#activeWorkerSlot]);
      await this.#untilRuntimeCrash(retireFencedSlot(previousSupervisor, secret));
      await this.#untilRuntimeCrash(this.#settleBackgroundWork());
      this.#logStream.flush();
      this.#activeWorkerSlot = (this.#activeWorkerSlot + 1) % slotSupervisorNames.length;
      this.#fencedRunId = `run-${++this.#fencedRunCounter}`;
      this.#variantVars = {};
      const nextSupervisor = this.#server.getWorker(slotSupervisorNames[this.#activeWorkerSlot]);
      await this.#untilRuntimeCrash(
        activateFencedSlot(nextSupervisor, secret, this.#fencedRunId, this.#readLiveWorkerVars()),
      );
      this.#fence = new RunFence();
      this.#context = this.#createContext();
      this.#cacheStorage = await this.#getCacheStorage();
      logTiming(`${this.#timingLabel} reset:slot`, slotStartedAt);
      this.#server.clearLogs();
      logTiming(`${this.#timingLabel} reset`, startedAt);
      return;
    }

    await this.#untilRuntimeCrash(this.#settleBackgroundWork());
    this.#logStream.flush();
    await this.#untilRuntimeCrash(this.#resetWorkerGeneration());
    this.#server.clearLogs();
    logTiming(`${this.#timingLabel} reset`, startedAt);
  }

  flushLogs() {
    this.#logStream.flush();
    this.#logStream.assertNoWaitUntilFailures();
  }

  /**
   * Ends one run of a shared lease without resetting the slot: waits for the background work it
   * started (waitUntil tasks, platform proxy calls, Browser Rendering sessions), then reports its
   * logs and any waitUntil failure, as a release does for a run of its own.
   */
  async settle() {
    const startedAt = performance.now();
    if (this.#closed) {
      throw new Error("Cloudflare harness run is closed");
    }

    await this.#untilRuntimeCrash(this.#settleBackgroundWork());
    this.flushLogs();
    logTiming(`${this.#timingLabel} settle`, startedAt);
  }

  async #settleBackgroundWork() {
    await drainHarnessRun({
      devEnvs: this.#capturedDevEnvs,
      drainBrowserRendering: this.options.hasBrowserRendering,
      platformProxyDispatches: this.#platformProxyDispatches,
    });
    await this.#closeActiveBrowserRenderingSessions();
    if (this.options.hasBrowserRendering) {
      await drainHarnessRun({
        devEnvs: this.#capturedDevEnvs,
        drainBrowserRendering: true,
        platformProxyDispatches: this.#platformProxyDispatches,
      });
    }
  }

  async close() {
    if (this.#closed) return;
    const startedAt = performance.now();
    this.#closed = true;
    const pendingDispatches = this.#fence.retire();
    if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP) {
      console.error("[bun-test-cloudflare] draining runtime messages");
    }
    // Work waiting on a crashed runtime may never settle, so a crash skips or ends the drains.
    const drain = async () => {
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
    };
    if (!this.#runtime.crash) {
      await this.#untilRuntimeCrash(pendingDispatches.then(drain)).catch((error) => {
        if (error !== this.#runtime.crash) throw error;
      });
    }
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

  /** The crash that condemned this run's runtime, if any; such a run must be closed, not reused. */
  get runtimeCrash(): WorkerRuntimeCrashError | undefined {
    return this.#runtime.crash;
  }

  /** Waits for the promise, or rejects at once if the runtime crashes first. */
  #untilRuntimeCrash<TResult>(promise: TResult | Promise<TResult>): Promise<TResult> {
    return this.#runtime.untilCrash(promise);
  }

  async #resetWorkerGeneration() {
    const generationStartedAt = performance.now();
    this.#capturedDevEnvs.length = 0;
    try {
      await this.#runWithFreshStorage(() =>
        devEnvCaptureContext.run(this.#capturedDevEnvs, () =>
          runWithWorkerdProcessOwner(this.#runtime, async () => {
            try {
              await this.#server.reset();
            } catch (error) {
              if (!isMissingMiniflareDispatcherClose(error)) {
                throw error;
              }
              await this.#server.listen();
            }
          }),
        ),
      );
    } finally {
      logTiming(`${this.#timingLabel} reset:generation`, generationStartedAt);
    }

    this.#fence = new RunFence();
    this.#context = this.#createContext();
    this.#cacheStorage = await this.#getCacheStorage();
  }

  #runWithFreshStorage<TResult>(callback: () => TResult) {
    const persistencePath = path.join(this.#storageRoot, String(this.#storageGeneration++));
    mkdirSync(persistencePath, { recursive: true });
    return runWithTestHarnessPersistencePath(persistencePath, callback);
  }

  /** The vars of the run taking the active slot: its Workers', with its variant's over them. */
  #runVars() {
    const vars = this.#readLiveWorkerVars();
    for (const [name, overrides] of Object.entries(this.#variantVars)) vars[name] = { ...vars[name], ...overrides };
    return vars;
  }

  /**
   * Gives the run taking this runtime its variant (`CloudflareHarness.with()`) before its code
   * runs: the slot was activated for whichever run took it next.
   */
  async configure(variant: RunVariant | undefined) {
    if (!variant) return;
    const fencedSlots = this.options.fencedSlots;
    if (!fencedSlots) throw new Error("A harness variant's run needs isolated Worker slots");
    await this.#untilRuntimeCrash(this.start());
    this.#variantVars = variant.vars;
    const supervisor = this.#server.getWorker(fencedSlots.slotSupervisorNames[this.#activeWorkerSlot]);
    await this.#untilRuntimeCrash(
      configureFencedRun(supervisor, fencedSlots.secret, this.#fencedRunId, this.#runVars(), variant.settings),
    );
    this.#context = this.#createContext();
  }

  #readLiveWorkerVars(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (const [index, [, workerConfig]] of this.options.workerEntries.entries()) {
      const name = this.options.fencedSlots?.workerSpecs[index]?.name;
      if (!name) continue;
      const configVars =
        "config" in workerConfig &&
        typeof workerConfig.config === "object" &&
        workerConfig.config !== null &&
        "vars" in workerConfig.config &&
        workerConfig.config.vars
          ? (workerConfig.config.vars as Record<string, unknown>)
          : {};
      const vars = "vars" in workerConfig && workerConfig.vars ? (workerConfig.vars as Record<string, unknown>) : {};
      const secrets =
        "secrets" in workerConfig && workerConfig.secrets ? (workerConfig.secrets as Record<string, unknown>) : {};
      const merged = { ...configVars, ...vars, ...secrets };
      if (Object.keys(merged).length > 0) {
        result[name] = merged;
      }
    }
    return result;
  }

  #createContext(): CloudflareHarnessRunContext<TWorkers> {
    if (this.options.fencedSlots) {
      const { secret, slotSupervisorNames, workerSpecs } = this.options.fencedSlots;
      const supervisor = this.#server.getWorker(slotSupervisorNames[this.#activeWorkerSlot]);
      const liveVars = this.#runVars();
      const workers = Object.fromEntries(
        this.options.workerEntries.map(([key], workerIndex) => {
          const spec = workerSpecs[workerIndex]!;
          return [
            key,
            createFencedWorkerHandle({
              fence: this.#fence,
              runId: this.#fencedRunId,
              runtimeVars: liveVars[spec.name],
              secret,
              spec,
              supervisor,
            }),
          ];
        }),
      ) as unknown as CloudflareWorkerMap<TWorkers>;
      return { workers, server: this.#getExposedServer(workers) };
    }

    const workers = Object.fromEntries(
      this.options.workerEntries.map(([key, worker]) => {
        const handle = this.#fence.worker(this.#server.getWorker(worker.name ?? String(key)));
        return [key, handle];
      }),
    ) as unknown as CloudflareWorkerMap<TWorkers>;
    return { workers, server: this.#getExposedServer(workers) };
  }

  async #getCacheStorage() {
    if (this.options.fencedSlots) {
      const { secret, slotSupervisorNames } = this.options.fencedSlots;
      const supervisor = this.#server.getWorker(slotSupervisorNames[this.#activeWorkerSlot]);
      return createFencedBunCacheStorage(supervisor, secret, this.#fencedRunId, this.#fence);
    }
    return getCapturedRuntimeCaches(this.#capturedDevEnvs);
  }

  #getExposedServer(workers: CloudflareWorkerMap<TWorkers>): TestHarness {
    const fence = this.#fence;
    const fencedSlots = this.options.fencedSlots;
    const call = <T>(callback: () => T): T => {
      fence.assertActive();
      return callback();
    };
    return {
      listen: () => fence.dispatch(() => this.#server.listen()),
      fetch: (input, init) => {
        const primary = fencedSlots && Object.values(workers)[0];
        if (primary) return primary.fetch(input, init);
        return fence.dispatch(() => this.#server.fetch(input, init));
      },
      getWorker: (name) => {
        const index = this.options.workerEntries.findIndex(
          ([key, worker]) => name === undefined || name === (worker.name ?? String(key)),
        );
        if (fencedSlots && index >= 0) {
          const [key] = this.options.workerEntries[index]!;
          return workers[key] as any;
        }
        return fence.worker(this.#server.getWorker(name));
      },
      getLogs: () => call(() => this.#server.getLogs()),
      clearLogs: () => call(() => this.#server.clearLogs()),
      debug: () => call(() => this.#server.debug()),
      update: (options) => fence.dispatch(() => this.#server.update(options)),
      reset: () => fence.dispatch(() => this.#server.reset()),
      close: () => fence.dispatch(() => this.#server.close()),
    };
  }

  async #closeActiveBrowserRenderingSessions() {
    if (!this.options.hasBrowserRendering || !this.#context) {
      return;
    }
    if (getObservedBrowserRenderingLaunchCount() === this.#initialBrowserRenderingLaunchCount) {
      return;
    }

    if (this.options.fencedSlots) {
      const supervisor = this.#server.getWorker(this.options.fencedSlots.slotSupervisorNames[this.#activeWorkerSlot]);
      try {
        const env = (await supervisor.getEnv()) as Record<string, unknown>;
        const binding = env.SHARED_BROWSER as Fetcher | undefined;
        if (!binding || typeof binding.fetch !== "function") return;
        const sessions = await getBrowserRenderingSessions(binding);
        if (process.env.BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP && sessions.length > 0) {
          console.error(
            `[bun-test-cloudflare] closing ${sessions.length} Browser Rendering session(s) for fenced slot`,
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
      return;
    }

    for (const preparedWorker of this.options.preparedWorkers) {
      const browserBindingName = preparedWorker.browserBindingName;
      if (!browserBindingName) {
        continue;
      }

      const worker = this.#server.getWorker(preparedWorker.name);

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
