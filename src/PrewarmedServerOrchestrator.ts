import type { HarnessRun } from "./HarnessRun";
import type { HarnessRunLease, ServerOrchestrator } from "./ServerOrchestrator";

export const WARM_WORKERD_POOL_SIZE = 2;

type PrewarmedServerOrchestratorRegistry = {
  closing: boolean;
  installed: boolean;
  orchestrators: Set<PrewarmedServerOrchestrator<any>>;
};

type WarmHarnessRun<TWorkers extends Record<string, any>> = {
  run: HarnessRun<TWorkers>;
  started: Promise<HarnessRun<TWorkers>>;
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

export const closePrewarmedServerOrchestrators = async () => {
  const registry = globalThis.__bunTestCloudflarePrewarmedServerOrchestrators;
  if (!registry || registry.closing) {
    return;
  }

  registry.closing = true;
  await Promise.allSettled(Array.from(registry.orchestrators, (orchestrator) => orchestrator.close()));
  registry.closing = false;
};

export class PrewarmedServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  readonly #available: Array<WarmHarnessRun<TWorkers>> = [];
  readonly #inUse = new Set<HarnessRun<TWorkers>>();
  #closed = false;

  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {
    getPrewarmedServerOrchestratorRegistry().orchestrators.add(this);
    this.#fillWarmPool();
  }

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    this.#assertOpen();

    const warmRun = this.#available.shift() ?? this.#createStartedRun();
    this.#fillWarmPool();

    const run = await warmRun.started;
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
    const availableRuns = this.#available.splice(0);
    this.#available.length = 0;

    await Promise.allSettled([
      ...availableRuns.map(({ run }) => run.close()),
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
    return { run, started };
  }

  #fillWarmPool() {
    if (this.#closed) return;

    while (this.#available.length < WARM_WORKERD_POOL_SIZE) {
      this.#available.push(this.#createStartedRun());
    }
  }
}
