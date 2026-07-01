import { afterAll } from "bun:test";
import type { HarnessRun } from "./HarnessRun";
import type { HarnessRunLease, ServerOrchestrator } from "./ServerOrchestrator";

export const WARM_WORKERD_POOL_SIZE = 2;

export class PrewarmedServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  readonly #available: Array<Promise<HarnessRun<TWorkers>>> = [];
  readonly #inUse = new Set<HarnessRun<TWorkers>>();
  #closed = false;

  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {
    this.#fillWarmPool();
    try {
      afterAll(() => this.close());
    } catch {}
  }

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    this.#assertOpen();

    const runPromise = this.#available.shift() ?? this.#createStartedRun();
    this.#fillWarmPool();

    const run = await runPromise;
    if (this.#closed) {
      await run.close();
      throw new Error("Cloudflare server orchestrator is closed");
    }

    this.#inUse.add(run);

    return {
      run,
      release: async () => {
        if (this.#inUse.delete(run)) {
          await run.close();
        }
        this.#fillWarmPool();
      },
    };
  }

  async close() {
    this.#closed = true;
    const availableRuns = await Promise.allSettled(this.#available);
    this.#available.length = 0;

    await Promise.allSettled([
      ...availableRuns.map((result) => (result.status === "fulfilled" ? result.value.close() : undefined)),
      ...Array.from(this.#inUse, (run) => run.close()),
    ]);
    this.#inUse.clear();
  }

  #assertOpen() {
    if (this.#closed) {
      throw new Error("Cloudflare server orchestrator is closed");
    }
  }

  #createStartedRun() {
    const run = this.createRun();
    const started = run.start().then(
      () => run,
      async (error) => {
        await run.close();
        throw error;
      },
    );
    started.catch(() => {});
    return started;
  }

  #fillWarmPool() {
    if (this.#closed) return;

    while (this.#available.length < WARM_WORKERD_POOL_SIZE) {
      this.#available.push(this.#createStartedRun());
    }
  }
}
