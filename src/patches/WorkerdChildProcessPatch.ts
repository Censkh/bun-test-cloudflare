import childProcess from "node:child_process";
import path from "node:path";

const isWorkerdServe = (command: string, args?: readonly string[]) => {
  return path.basename(command).includes("workerd") && args?.includes("serve");
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
      child.unref();
      child.stdin?.unref?.();
      child.stdout?.unref?.();
      child.stderr?.unref?.();
    }

    return child;
  } as typeof childProcess.spawn;

  Object.defineProperty(childProcess.spawn, "__bunTestCloudflareWorkerdChildProcessPatched", {
    value: true,
  });
};
