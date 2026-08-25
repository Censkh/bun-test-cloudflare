import childProcess from "node:child_process";
import path from "node:path";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";

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

const getWorkerdChildProcessPatchOptions = (): WorkerdChildProcessPatchOptions => ({
  stdioErrors: shouldInstallCompatibilityPatch("workerd-child-process-stdio-errors"),
  stdioUnref: shouldInstallCompatibilityPatch("workerd-child-process-stdio-unref"),
  unref: shouldInstallCompatibilityPatch("workerd-child-process-unref"),
});

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

export const installWorkerdChildProcessPatch = () => {
  if ((childProcess.spawn as any).__bunTestCloudflareWorkerdChildProcessPatched) {
    return;
  }

  const originalSpawn = childProcess.spawn;

  childProcess.spawn = function bunTestCloudflareWorkerdSpawn(
    this: unknown,
    command: string,
    args?: readonly string[],
    options?: childProcess.SpawnOptions,
  ) {
    const child = originalSpawn.call(this as any, command, args as string[], options as any);

    if (isWorkerdServe(command, args)) {
      patchWorkerdChildProcess(child);
    }

    return child;
  } as typeof childProcess.spawn;

  Object.defineProperty(childProcess.spawn, "__bunTestCloudflareWorkerdChildProcessPatched", {
    value: true,
  });
};
