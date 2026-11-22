import type { FencedRunSettings } from "./FencedEnvBridge";
import type { HarnessRun } from "./HarnessRun";

/** What a harness variant's run sets over its harness's config, by Worker name. */
export type RunVariant = {
  vars: Record<string, Record<string, unknown>>;
  settings: FencedRunSettings;
};

export type HarnessRunLease<TWorkers extends Record<string, any>> = {
  release(): Promise<void>;
  run: Pick<HarnessRun<TWorkers>, "execute" | "settle">;
};

/** Local pools may have activated the slot before its next caller's variant was known. */
export const configureLocalLease = async <TWorkers extends Record<string, any>>(
  run: HarnessRun<TWorkers>,
  release: () => Promise<void>,
  variant?: RunVariant,
): Promise<HarnessRunLease<TWorkers>> => {
  try {
    if (variant) await run.configure(variant);
    return { run, release };
  } catch (error) {
    await release();
    throw error;
  }
};

export type ServerOrchestrator<TWorkers extends Record<string, any>> = {
  acquire(variant?: RunVariant): Promise<HarnessRunLease<TWorkers>>;
  close(): Promise<void>;
  /** Whether it was closed (by its harness's scope or the run-wide cleanup): it takes no more leases. */
  readonly closed?: boolean;
  /** Frees what the orchestrator keeps ready for later leases, while another harness is in use. */
  releaseIdleRuns?(): void;
};

export class InlineServerOrchestrator<TWorkers extends Record<string, any>> implements ServerOrchestrator<TWorkers> {
  constructor(private readonly createRun: () => HarnessRun<TWorkers>) {}

  async acquire(variant?: RunVariant): Promise<HarnessRunLease<TWorkers>> {
    const run = this.createRun();
    await run.start();

    return configureLocalLease(run, () => run.close(), variant);
  }

  async close() {}
}
