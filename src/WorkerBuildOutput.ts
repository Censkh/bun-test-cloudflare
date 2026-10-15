import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

const runDirectoryPattern = /^run-(\d+)$/;

export const isErrnoException = (error: unknown): error is NodeJS.ErrnoException =>
  error instanceof Error && "code" in error;

export const isProcessAlive = (processId: number) => {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return isErrnoException(error) && error.code === "EPERM";
  }
};

const sanitizeWorkerName = (workerName: string) => workerName.replace(/[^a-zA-Z0-9._-]/g, "-");

export const getWorkerBuildRoot = (baseDirectory: string) =>
  path.join(baseDirectory, "node_modules/.btcf/worker-build");

/**
 * Each `bun test` run builds into its own directory, one per distinct build config, so a concurrent run or a
 * second harness with a different config never replaces a `worker.js` that a running workerd still loads.
 */
export const getWorkerBuildOutdir = (baseDirectory: string, runKey: string, workerName: string, buildKey: string) =>
  path.join(
    getWorkerBuildRoot(baseDirectory),
    `run-${runKey}`,
    `${sanitizeWorkerName(workerName)}-${buildKey.slice(0, 16)}`,
  );

/** Removes build output left by `bun test` runs that are no longer alive. */
export const removeFinishedRunBuilds = (baseDirectory: string, isRunAlive: (runKey: number) => boolean) => {
  const buildRoot = getWorkerBuildRoot(baseDirectory);
  let entries: string[];
  try {
    entries = readdirSync(buildRoot);
  } catch {
    return;
  }

  for (const entry of entries) {
    const runKey = Number(runDirectoryPattern.exec(entry)?.[1]);
    if (!Number.isSafeInteger(runKey) || runKey <= 0 || isRunAlive(runKey)) {
      continue;
    }
    try {
      rmSync(path.join(buildRoot, entry), { force: true, recursive: true });
    } catch {
      // Another run may be removing the same directory.
    }
  }
};
