import type { HarnessRun } from "./HarnessRun";
import type { HarnessRunLease, ServerOrchestrator } from "./ServerOrchestrator";

export const WARM_WORKERD_POOL_SIZE = 2;

type PrewarmedServerOrchestratorRegistry = {
  closing: boolean;
  installed: boolean;
  orchestrators: Set<PrewarmedServerOrchestrator<any>>;
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

export class PrewarmedServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  readonly #available: Array<Promise<HarnessRun<TWorkers>>> = [];
  readonly #inUse = new Set<HarnessRun<TWorkers>>();
  #closed = false;

  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {
    getPrewarmedServerOrchestratorRegistry().orchestrators.add(this);
    this.#fillWarmPool();
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
    getPrewarmedServerOrchestratorRegistry().orchestrators.delete(this);
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
