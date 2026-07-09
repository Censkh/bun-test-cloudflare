import { expect, test } from "bun:test";
import childProcess from "node:child_process";
import { mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  installWorkerdProcessPatch,
  terminateWorkerdProcesses,
  workerdProcessCaptureContext,
} from "../src/patches/WorkerdProcessPatch";

const waitForExit = (process: childProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    process.once("exit", () => resolve());
  });

test("WorkerdProcessPatch tracks and terminates workerd children spawned in the active run", async () => {
  installWorkerdProcessPatch();

  const tempDirectory = mkdtempSync(path.join(tmpdir(), "btcf-workerd-patch-"));
  const fakeWorkerdPath = path.join(tempDirectory, "workerd");
  symlinkSync(process.execPath, fakeWorkerdPath);

  const trackedProcesses = new Set<childProcess.ChildProcess>();
  const untrackedProcess = childProcess.spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"]);
  const trackedProcess = await workerdProcessCaptureContext.run(trackedProcesses, () =>
    childProcess.spawn(fakeWorkerdPath, ["--eval", "setInterval(() => {}, 1000)"]),
  );

  try {
    expect(trackedProcesses.has(trackedProcess)).toBe(true);
    expect(trackedProcesses.has(untrackedProcess)).toBe(false);

    await terminateWorkerdProcesses(trackedProcesses);
    expect(trackedProcess.signalCode).toBe("SIGKILL");
  } finally {
    untrackedProcess.kill("SIGKILL");
    await waitForExit(untrackedProcess);
  }
});
