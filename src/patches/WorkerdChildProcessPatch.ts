import childProcess from "node:child_process";
import path from "node:path";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";
import { trackSpawnedWorkerdProcess } from "../WorkerRuntimeCrash";

type UnrefableStream = {
  on?: (event: "error", listener: (error: Error) => void) => unknown;
  unref?: () => void;
};

type WorkerdChildProcessPatchOptions = {
  stdioErrors: boolean;
  stdioUnref: boolean;
  unref: boolean;
};

const isWorkerdServe = (command: string, args?: readonly string[]) => {
  return path.basename(command).includes("workerd") && args?.includes("serve");
};

const getWorkerdChildProcessPatchOptions = (): WorkerdChildProcessPatchOptions => {
  const enabled = shouldInstallCompatibilityPatch("workerd-child-process");
  return {
    stdioErrors: enabled && shouldInstallCompatibilityPatch("workerd-child-process-stdio-errors"),
    stdioUnref: enabled && shouldInstallCompatibilityPatch("workerd-child-process-stdio-unref"),
    unref: enabled && shouldInstallCompatibilityPatch("workerd-child-process-unref"),
  };
};

export const patchWorkerdChildProcess = (
  child: childProcess.ChildProcess,
  options: WorkerdChildProcessPatchOptions = getWorkerdChildProcessPatchOptions(),
) => {
  if (options.stdioErrors) {
    for (const stream of child.stdio) {
      (stream as UnrefableStream | null)?.on?.("error", () => {});
    }
  }
  if (options.unref) {
    child.unref();
  }
  if (options.stdioUnref) {
    for (const stream of child.stdio.slice(0, 3)) {
      (stream as UnrefableStream | null)?.unref?.();
    }
  }
};

let installed = false;

/**
 * Wraps child_process.spawn for workerd: tracks each runtime for crash detection (always, since a
 * run must not wait forever on a dead runtime) and applies the enabled stdio compatibility patches.
 */
export const installWorkerdChildProcessPatch = () => {
  // Another patch may wrap spawn after this one, so the flag can't live on the function.
  if (installed) {
    return;
  }
  installed = true;

  const originalSpawn = childProcess.spawn;

  childProcess.spawn = function bunTestCloudflareWorkerdSpawn(
    this: unknown,
    command: string,
    args?: readonly string[],
    options?: childProcess.SpawnOptions,
  ) {
    const child = originalSpawn.call(this as any, command, args as string[], options as any);

    if (isWorkerdServe(command, args)) {
      trackSpawnedWorkerdProcess(child);
      patchWorkerdChildProcess(child);
    }

    return child;
  } as typeof childProcess.spawn;
};
