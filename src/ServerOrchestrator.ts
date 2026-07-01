import type { HarnessRun } from "./HarnessRun";

export type HarnessRunLease<TWorkers extends Record<string, any>> = {
  release(): Promise<void>;
  run: HarnessRun<TWorkers>;
};

export type ServerOrchestrator<TWorkers extends Record<string, any>> = {
  acquire(): Promise<HarnessRunLease<TWorkers>>;
  close(): Promise<void>;
};

export class InlineServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {}

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    const run = this.createRun();
    await run.start();

    return {
      run,
      release: () => run.close(),
    };
  }

  async close() {}
}
