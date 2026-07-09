import { mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import childProcess, { type ChildProcess } from "node:child_process";
import path from "node:path";

export const workerdProcessCaptureContext = new AsyncLocalStorage<Set<ChildProcess>>();

const isWorkerdCommand = (command: unknown) =>
  typeof command === "string" && path.basename(command).startsWith("workerd");

const waitForExit = (process: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }

    process.once("exit", () => resolve());
  });

export const terminateWorkerdProcesses = async (processes: Set<ChildProcess>) => {
  const liveProcesses = Array.from(processes).filter(
    (process) => process.exitCode === null && process.signalCode === null,
  );

  for (const process of liveProcesses) {
    process.kill("SIGKILL");
  }

  await Promise.allSettled(liveProcesses.map(waitForExit));
};

export const installWorkerdProcessPatch = () => {
  if ((childProcess.spawn as any).__bunTestCloudflareWorkerdPatched) {
    return;
  }

  const originalSpawn = childProcess.spawn;
  const spawn = ((...args: Parameters<typeof childProcess.spawn>) => {
    const spawnedProcess = originalSpawn(...args);
    if (isWorkerdCommand(args[0])) {
      const store = workerdProcessCaptureContext.getStore();
      store?.add(spawnedProcess);
      spawnedProcess.once("exit", () => {
        store?.delete(spawnedProcess);
      });
    }
    return spawnedProcess;
  }) as typeof childProcess.spawn;

  Object.defineProperty(spawn, "__bunTestCloudflareWorkerdPatched", {
    value: true,
  });

  childProcess.spawn = spawn;

  mock.module("node:child_process", () => ({
    ...childProcess,
    default: {
      ...childProcess,
      spawn,
    },
    spawn,
  }));
};
