import childProcess from "node:child_process";
import path from "node:path";

const liveWorkerdProcesses = new Set<childProcess.ChildProcess>();
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
  return child;
} as typeof childProcess.spawn;

/** How many workerd processes are running, once any that are exiting have gone (up to 10 seconds). */
export const settledWorkerdCount = async () => {
  const deadline = Date.now() + 10_000;
  let previous = -1;
  while (Date.now() < deadline) {
    const count = liveWorkerdProcesses.size;
    if (count === 0 || count === previous) return count;
    previous = count;
    await Bun.sleep(500);
  }
  return liveWorkerdProcesses.size;
};
