import { appendFileSync } from "node:fs";

// Preload: records each Worker build process the harness starts, one line per start.
const spawnSync = Bun.spawnSync;
Bun.spawnSync = ((options: Parameters<typeof spawnSync>[0], ...rest: unknown[]) => {
  const cmd = Array.isArray(options) ? options : (options as { cmd?: string[] }).cmd;
  if (cmd?.some((argument) => argument.endsWith("WorkerBuildProcess.ts"))) {
    appendFileSync(process.env.BTCF_BUILD_PROCESS_LOG!, "started\n");
  }
  return (spawnSync as (...args: unknown[]) => unknown)(options, ...rest);
}) as typeof spawnSync;
