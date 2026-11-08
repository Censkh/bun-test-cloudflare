import childProcess from "node:child_process";
import path from "node:path";

const liveWorkerdProcesses = new Set<childProcess.ChildProcess>();
const esbuildServices = new Set<childProcess.ChildProcess>();
const originalSpawn = childProcess.spawn;

childProcess.spawn = function recordWorkerdSpawn(
  this: unknown,
  command: string,
  args?: readonly string[],
  options?: childProcess.SpawnOptions,
) {
  const child = originalSpawn.call(this as any, command, args as string[], options as any);
  if (path.basename(command).includes("workerd") && args?.includes("serve")) {
    liveWorkerdProcesses.add(child);
    child.once("exit", () => liveWorkerdProcesses.delete(child));
  }
  if (args?.some((arg) => arg.startsWith("--service="))) {
    esbuildServices.add(child);
    child.once("exit", () => esbuildServices.delete(child));
  }
  return child;
} as typeof childProcess.spawn;

/** Sends SIGTERM to every live workerd from outside, as Bun does to all children when a test times out. */
export const killLiveWorkerdProcesses = () => {
  const killed = [...liveWorkerdProcesses].filter((child) => child.pid !== undefined && child.exitCode === null);
  for (const child of killed) process.kill(child.pid!, "SIGTERM");
  return killed.length;
};

const signalEsbuildServices = (signal: NodeJS.Signals) => {
  for (const child of esbuildServices) process.kill(child.pid!, signal);
  return esbuildServices.size;
};

/** Leaves esbuild's service running but answering nothing. */
export const freezeEsbuildServices = () => signalEsbuildServices("SIGSTOP");
export const thawEsbuildServices = () => signalEsbuildServices("SIGCONT");
