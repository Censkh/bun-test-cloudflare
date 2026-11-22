import type { FencedRunSettings } from "./FencedEnvBridge";
import type { HarnessRun } from "./HarnessRun";

/** What a harness variant's run sets over its harness's config, by Worker name. */
export type RunVariant = {
  vars: Record<string, Record<string, unknown>>;
  settings: FencedRunSettings;
};

export type HarnessRunLease<TWorkers extends Record<string, any>> = {
  release(): Promise<void>;
  run: Pick<HarnessRun<TWorkers>, "configure" | "execute" | "settle">;
};

export type ServerOrchestrator<TWorkers extends Record<string, any>> = {
  acquire(): Promise<HarnessRunLease<TWorkers>>;
  close(): Promise<void>;
  /** Whether it was closed (by its harness's scope or the run-wide cleanup): it takes no more leases. */
  readonly closed?: boolean;
  /** Frees what the orchestrator keeps ready for later leases, while another harness is in use. */
  releaseIdleRuns?(): void;
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
