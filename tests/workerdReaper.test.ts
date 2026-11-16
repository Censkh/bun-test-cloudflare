import { afterAll, expect, test } from "bun:test";
import childProcess from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const directory = mkdtempSync(path.join(os.tmpdir(), "workerd-reaper-"));
// A stand-in workerd (Bun under that name): the reaper only stops processes whose command is workerd.
const workerd = path.join(directory, "workerd");
copyFileSync(process.execPath, workerd);
const started: number[] = [];
afterAll(() => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  rmSync(directory, { force: true, recursive: true });
});

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const stopsWithin = async (pid: number, ms: number) => {
  const deadline = Date.now() + ms;
  while (isRunning(pid) && Date.now() < deadline) await Bun.sleep(100);
  return !isRunning(pid);
};

/** Runs a process that lists a stand-in workerd with the reaper and then dies without stopping it. */
const ownerDies = (mode = "") => {
  const result = Bun.spawnSync(["bun", path.join(import.meta.dir, "fixtures/reaperOwner.ts"), workerd, mode]);
  const pids = JSON.parse(result.stdout.toString()) as { workerd: number; watchdog: number };
  started.push(pids.workerd, pids.watchdog);
  return pids;
};

test.skipIf(process.platform === "win32")(
  "a workerd its process left running is stopped once the process has gone",
  async () => {
    const { workerd: pid } = ownerDies();
    expect(await stopsWithin(pid, 10_000)).toBe(true);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "when the watchdog was killed too, the next process's watchdog stops what was left",
  async () => {
    const { workerd: pid, watchdog } = ownerDies("kill-watchdog");
    expect(await stopsWithin(watchdog, 2_000)).toBe(true);
    expect(await stopsWithin(pid, 2_000)).toBe(false);
    // Another process listing a runtime starts its watchdog, which sweeps first.
    ownerDies();
    expect(await stopsWithin(pid, 10_000)).toBe(true);
  },
  30_000,
);

test.skipIf(process.platform === "win32")(
  "a listed pid that is no longer a workerd is left alone",
  async () => {
    // A process that has gone listed a pid that now belongs to something else.
    const gone = Bun.spawnSync(["/usr/bin/true"]).pid;
    const other = childProcess.spawn("/bin/sleep", ["60"], { stdio: "ignore" });
    started.push(other.pid!);
    const listing = path.join(os.tmpdir(), "bun-test-cloudflare-reaper", `${gone}.workerd-reused`);
    mkdirSync(path.dirname(listing), { recursive: true });
    writeFileSync(listing, `${other.pid}\n`);
    // The next process's watchdog sweeps what gone processes listed.
    ownerDies();
    expect(existsSync(listing)).toBe(false);
    // Still running: a killed child of this process would stay a zombie that `kill -0` still finds.
    await Bun.sleep(500);
    expect({ exitCode: other.exitCode, signalCode: other.signalCode }).toEqual({ exitCode: null, signalCode: null });
  },
  30_000,
);
