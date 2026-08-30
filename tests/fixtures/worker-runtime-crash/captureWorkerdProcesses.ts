import childProcess from "node:child_process";
import path from "node:path";

declare global {
  var __workerRuntimeCrashWorkerdProcesses: Set<childProcess.ChildProcess> | undefined;
}

const workerdProcesses = (globalThis.__workerRuntimeCrashWorkerdProcesses ??= new Set());
const originalSpawn = childProcess.spawn;
let crashSpawnedWorkerdProcesses = false;

const crashWorkerdProcess = (child: childProcess.ChildProcess) => {
  if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
};

childProcess.spawn = function workerRuntimeCrashSpawn(
  this: unknown,
  command: string,
  args?: readonly string[],
  options?: childProcess.SpawnOptions,
) {
  const child = originalSpawn.call(this as any, command, args as string[], options as any);
  if (path.basename(command).includes("workerd") && args?.includes("serve")) {
    workerdProcesses.add(child);
    child.once("exit", () => workerdProcesses.delete(child));
    if (crashSpawnedWorkerdProcesses) {
      setTimeout(() => crashWorkerdProcess(child), 0).unref();
    }
  }
  return child;
} as typeof childProcess.spawn;

export const startWorkerdCrashLoop = () => {
  crashSpawnedWorkerdProcesses = true;
  const runningProcesses = Array.from(workerdProcesses).filter((child) => child.exitCode === null);
  for (const child of runningProcesses) {
    crashWorkerdProcess(child);
  }
  return runningProcesses.length;
};
