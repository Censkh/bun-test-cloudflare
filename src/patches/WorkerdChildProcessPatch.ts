import childProcess from "node:child_process";
import path from "node:path";

type UnrefableStream = {
  unref?: () => void;
};

const isWorkerdServe = (command: string, args?: readonly string[]) => {
  return path.basename(command).includes("workerd") && args?.includes("serve");
};

const unrefChildProcess = (child: childProcess.ChildProcess) => {
  child.unref();
  for (const stream of child.stdio ?? []) {
    (stream as UnrefableStream | null)?.unref?.();
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
      unrefChildProcess(child);
    }

    return child;
  } as typeof childProcess.spawn;

  Object.defineProperty(childProcess.spawn, "__bunTestCloudflareWorkerdChildProcessPatched", {
    value: true,
  });
};
