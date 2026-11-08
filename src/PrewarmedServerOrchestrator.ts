import type { HarnessRun } from "./HarnessRun";
import { stopWranglerEsbuildService } from "./patches/WranglerGuessWorkerFormatPatch";
import type { HarnessRunLease, ServerOrchestrator } from "./ServerOrchestrator";

export const WARM_WORKERD_POOL_SIZE = 1;
const DEFAULT_WARM_WORKERD_START_TIMEOUT_MS = 30_000;

type PrewarmedServerOrchestratorRegistry = {
  closing: boolean;
  installed: boolean;
  orchestrators: Set<ServerOrchestrator<any>>;
};

type WarmHarnessRun<TWorkers extends Record<string, any>> = {
  phase: "reset" | "startup";
  preferForNextLease: boolean;
  run: HarnessRun<TWorkers>;
  started: Promise<HarnessRun<TWorkers>>;
  status: "failed" | "pending" | "ready";
};

declare global {
  var __bunTestCloudflarePrewarmedServerOrchestrators: PrewarmedServerOrchestratorRegistry | undefined;
}

const getPrewarmedServerOrchestratorRegistry = () => {
  const registry = (globalThis.__bunTestCloudflarePrewarmedServerOrchestrators ??= {
    closing: false,
    installed: false,
    orchestrators: new Set<PrewarmedServerOrchestrator<any>>(),
  });

  if (!registry.installed) {
    registry.installed = true;
    process.once("beforeExit", async () => {
      if (registry.closing) {
        return;
      }

      registry.closing = true;
      await Promise.allSettled(Array.from(registry.orchestrators, (orchestrator) => orchestrator.close()));
    });
  }

  return registry;
};

const getWarmStartTimeoutMs = () => {
  const value = Number(process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_WARM_WORKERD_START_TIMEOUT_MS;
};

const waitForWarmStart = async <TWorkers extends Record<string, any>>(
  warmRun: Pick<WarmHarnessRun<TWorkers>, "started">,
  timeoutMs = getWarmStartTimeoutMs(),
) => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      warmRun.started,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Timed out waiting for prewarmed Cloudflare server startup after ${timeoutMs}ms`));
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
};

const logDiscardedWarmRun = (phase: string, error: unknown) => {
  if (process.env.BUN_TEST_CLOUDFLARE_TIMINGS !== "1") return;

  console.error(`[bun-test-cloudflare] discarded prewarmed server during ${phase}`);
  console.error(error);
};

export const closePrewarmedServerOrchestrators = async () => {
  const registry = globalThis.__bunTestCloudflarePrewarmedServerOrchestrators;
  if (!registry || registry.closing) {
    return;
  }

  registry.closing = true;
  try {
    await Promise.allSettled(Array.from(registry.orchestrators, (orchestrator) => orchestrator.close()));
  } finally {
    registry.closing = false;
    stopWranglerEsbuildService();
  }
};

export class PrewarmedServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  readonly #available: Array<WarmHarnessRun<TWorkers>> = [];
  readonly #inUse = new Set<HarnessRun<TWorkers>>();
  // Runs that lost a start race, closing once their own start settles
  readonly #closing = new Set<Promise<void>>();
  #closed = false;

  constructor(
    private readonly createRun: () => HarnessRun<TWorkers>,
    private readonly poolSize = WARM_WORKERD_POOL_SIZE,
  ) {
    getPrewarmedServerOrchestratorRegistry().orchestrators.add(this);
    this.#fillWarmPool();
  }

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    this.#assertOpen();

    let run: HarnessRun<TWorkers>;
    let discardedRuns = 0;
    while (true) {
      const warmRun = this.#takeAvailableRun() ?? this.#createStartedRun();

      try {
        run = await this.#waitForStartOrReplacement(warmRun);
      } catch (error) {
        logDiscardedWarmRun(warmRun.phase, error);
        discardedRuns += 1;
        if (discardedRuns > this.poolSize) {
          throw error;
        }
        continue;
      }

      if (this.#closed) {
        await run.close().catch(() => {});
        throw new Error("Cloudflare server orchestrator is closed");
      }

      try {
        await run.assertUsable();
        break;
      } catch (error) {
        logDiscardedWarmRun("reset", error);
        await run.close().catch(() => {});
        discardedRuns += 1;
        if (discardedRuns > this.poolSize) {
          throw error;
        }
      }
    }

    this.#inUse.add(run);

    return {
      run,
      release: async () => {
        if (!this.#inUse.delete(run)) {
          return;
        }
        if (run.runtimeCrash) {
          // The run already failed with the crash; the pool replaces it with a new runtime.
          await run.close().catch(() => {});
          this.#fillWarmPool();
          return;
        }

        try {
          run.flushLogs();
        } catch (error) {
          await run.close().catch(() => {});
          this.#fillWarmPool();
          throw error;
        }
        if (!this.#closed && this.#available.length + this.#inUse.size < this.poolSize) {
          this.#available.push(this.#createResetRun(run));
        } else {
          await run.close();
        }
        this.#fillWarmPool();
      },
    };
  }

  async close() {
    getPrewarmedServerOrchestratorRegistry().orchestrators.delete(this);
    this.#closed = true;
    const availableRuns = this.#available.splice(0);
    this.#available.length = 0;

    await Promise.allSettled([
      ...availableRuns.map((warmRun) => this.#closeWarmRun(warmRun)),
      ...Array.from(this.#inUse, (run) => run.close()),
      ...this.#closing,
    ]);
    this.#inUse.clear();
  }

  /**
   * Waits for a run to start. One still starting after the timeout may be stuck, or only slow on a
   * busy machine, so a fresh start races it and the first to finish is used. Closing the slow one
   * instead would throw its progress away (and can leave workerd running) while the replacement
   * competes with it for the same machine.
   */
  async #waitForStartOrReplacement(warmRun: WarmHarnessRun<TWorkers>) {
    try {
      return await waitForWarmStart(warmRun);
    } catch (error) {
      if (warmRun.status === "failed") throw error;
      logDiscardedWarmRun(warmRun.phase, error);
      const replacement = this.#createStartedRun();
      const started = (candidate: WarmHarnessRun<TWorkers>, other: WarmHarnessRun<TWorkers>) =>
        candidate.started.then((run) => ({ run, other }));
      const raced = {
        started: Promise.any([started(warmRun, replacement), started(replacement, warmRun)]).then(({ run, other }) => {
          this.#closeInBackground(other);
          return run;
        }),
      };
      try {
        // The machine is evidently slow, so the race gets twice the usual time.
        return await waitForWarmStart(raced, getWarmStartTimeoutMs() * 2);
      } catch (raceError) {
        this.#closeInBackground(warmRun);
        this.#closeInBackground(replacement);
        throw raceError;
      }
    }
  }

  #closeInBackground(warmRun: WarmHarnessRun<TWorkers>) {
    const closing = this.#closeWarmRun(warmRun)
      .catch(() => {})
      .finally(() => this.#closing.delete(closing));
    this.#closing.add(closing);
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("Cloudflare server orchestrator is closed");
    }
  }

  #createStartedRun(): WarmHarnessRun<TWorkers> {
    const run = this.createRun();
    return this.#createPreparingRun(run, "startup", false, () => run.start());
  }

  #createResetRun(run: HarnessRun<TWorkers>): WarmHarnessRun<TWorkers> {
    return this.#createPreparingRun(run, "reset", run.canRotateWorkerSlotForReuse?.() ?? false, () =>
      run.resetForReuse(),
    );
  }

  #createPreparingRun(
    run: HarnessRun<TWorkers>,
    phase: WarmHarnessRun<TWorkers>["phase"],
    preferForNextLease: boolean,
    prepare: () => Promise<unknown>,
  ): WarmHarnessRun<TWorkers> {
    const warmRun: WarmHarnessRun<TWorkers> = {
      phase,
      preferForNextLease,
      run,
      started: undefined as unknown as Promise<HarnessRun<TWorkers>>,
      status: "pending",
    };
    warmRun.started = prepare().then(
      () => run,
      async (error) => {
        warmRun.status = "failed";
        await run.close().catch(() => {});
        throw error;
      },
    );
    warmRun.started.then(
      () => {
        warmRun.status = "ready";
      },
      () => {},
    );
    return warmRun;
  }

  #takeAvailableRun() {
    let reusableIndex = -1;
    for (let index = this.#available.length - 1; index >= 0; index -= 1) {
      if (this.#available[index]?.preferForNextLease) {
        reusableIndex = index;
        break;
      }
    }
    const readyIndex =
      reusableIndex >= 0 ? reusableIndex : this.#available.findIndex((warmRun) => warmRun.status === "ready");
    const settledIndex =
      readyIndex >= 0 ? readyIndex : this.#available.findIndex((warmRun) => warmRun.status === "failed");
    const index = Math.max(settledIndex, 0);
    return this.#available.splice(index, 1)[0];
  }

  async #closeWarmRun(warmRun: WarmHarnessRun<TWorkers>) {
    const { run } = warmRun;
    // Closing a Wrangler harness while server.listen() is still starting can
    // leave workerd children behind. Wait for startup to settle when possible,
    // but never let a stuck background prewarm block test teardown forever.
    await waitForWarmStart(warmRun).catch(() => {});
    await run.close();
  }

  #fillWarmPool() {
    if (this.#closed) return;

    while (this.#available.length + this.#inUse.size < this.poolSize) {
      this.#available.push(this.#createStartedRun());
    }
  }
}

export class ReusableServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  #closed = false;
  #leaseTail = Promise.resolve();
  #run: HarnessRun<TWorkers> | undefined;

  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {
    getPrewarmedServerOrchestratorRegistry().orchestrators.add(this);
  }

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    this.#assertOpen();

    const previousLease = this.#leaseTail;
    let releaseLease!: () => void;
    this.#leaseTail = new Promise<void>((resolve) => {
      releaseLease = resolve;
    });
    await previousLease;

    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      releaseLease();
    };

    try {
      this.#assertOpen();
      const run = this.#run;
      if (run?.runtimeCrash) {
        this.#run = undefined;
        await run.close().catch(() => {});
      } else if (run) {
        await run.resetForReuse();
        await run.assertUsable();
        return { run, release };
      }

      const createdRun = this.createRun();
      this.#run = createdRun;
      await createdRun.start();
      await createdRun.assertUsable();
      return { run: createdRun, release };
    } catch (error) {
      const run = this.#run;
      this.#run = undefined;
      await run?.close().catch(() => {});
      await release();
      throw error;
    }
  }

  async close() {
    getPrewarmedServerOrchestratorRegistry().orchestrators.delete(this);
    this.#closed = true;
    const run = this.#run;
    this.#run = undefined;
    await run?.close();
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("Cloudflare server orchestrator is closed");
    }
  }
}
