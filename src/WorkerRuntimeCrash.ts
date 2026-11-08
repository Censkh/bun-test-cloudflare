import { AsyncLocalStorage } from "node:async_hooks";

export const WORKER_RUNTIME_CRASHED = "ERR_WORKER_RUNTIME_CRASHED";

/** A run's workerd process exited without the harness or Miniflare stopping it. */
export class WorkerRuntimeCrashError extends Error {
  readonly code = WORKER_RUNTIME_CRASHED;

  constructor(
    readonly pid: number | undefined,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
  ) {
    const how = signal ? `was killed by ${signal}` : `exited with code ${exitCode}`;
    super(
      `The Workers runtime crashed: workerd${pid === undefined ? "" : ` (pid ${pid})`} ${how}. ` +
        "This run can't continue; the next harness run starts a new runtime. " +
        "Bun kills every child process when a test times out, so an earlier timeout can cause this.",
    );
    this.name = "WorkerRuntimeCrashError";
  }
}

/** The part of a ChildProcess the monitor needs. */
export type WorkerdProcess = {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
};

export type RuntimeCrashMonitor = {
  /** Rejects with the first crash; never settles otherwise. */
  readonly crashed: Promise<never>;
  readonly crash: WorkerRuntimeCrashError | undefined;
  assertAlive(): void;
  track(child: WorkerdProcess): void;
};

/**
 * Watches the workerd processes a run starts. Miniflare stops workerd only through the process's
 * own kill() (SIGKILL on dispose, including when it replaces the runtime for a reset), so an exit
 * that no kill() call asked for is a crash: workerd failing, the OOM killer, or Bun killing every
 * child process when a test times out. Miniflare restarts a crashed runtime itself, but the
 * bindings, Durable Object state and connections a run holds don't survive, and requests to them
 * can wait forever, so the run is condemned instead.
 */
export const createRuntimeCrashMonitor = (): RuntimeCrashMonitor => {
  let crash: WorkerRuntimeCrashError | undefined;
  let rejectCrashed!: (error: WorkerRuntimeCrashError) => void;
  const crashed = new Promise<never>((_, reject) => {
    rejectCrashed = reject;
  });
  crashed.catch(() => {});

  return {
    crashed,
    get crash() {
      return crash;
    },
    assertAlive() {
      if (crash) throw crash;
    },
    track(child) {
      let stoppedByOwner = false;
      const kill = child.kill.bind(child);
      child.kill = (signal) => {
        stoppedByOwner = true;
        return kill(signal);
      };
      child.once("exit", (exitCode, signal) => {
        if (stoppedByOwner || crash) return;
        crash = new WorkerRuntimeCrashError(child.pid, exitCode, signal);
        rejectCrashed(crash);
      });
    },
  };
};

const workerdProcessOwner = new AsyncLocalStorage<RuntimeCrashMonitor>();

/** workerd processes spawned inside the callback are tracked by the monitor. */
export const runWithWorkerdProcessOwner = <TResult>(monitor: RuntimeCrashMonitor, callback: () => TResult) =>
  workerdProcessOwner.run(monitor, callback);

export const trackSpawnedWorkerdProcess = (child: WorkerdProcess) => {
  workerdProcessOwner.getStore()?.track(child);
};
