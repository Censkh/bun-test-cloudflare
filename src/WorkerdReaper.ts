import childProcess from "node:child_process";
import crypto from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Stops this process's workerd runtimes when the process ends without stopping them: Bun ends a
 * `--parallel` test worker without running its exit hooks once its last file is done, an
 * interrupted run is killed, and a runtime kept for a later test file (files sharing one global)
 * is otherwise only stopped by an exit hook. Each workerd's pid is listed, until it exits, in a
 * file of this global's (an isolated test file has a global of its own), and one detached
 * watchdog per process polls the process and, once it has gone, stops every runtime still listed.
 * Bun kills an isolated file's child processes when the file ends, the watchdog among them, so
 * each watchdog that starts first stops what a process that has gone left listed.
 */

const reaperDirectory = path.join(os.tmpdir(), "bun-test-cloudflare-reaper");
const watchdogFile = (pid: number) => path.join(reaperDirectory, `${pid}.watchdog`);
const pidFile = path.join(reaperDirectory, `${process.pid}.workerd-${crypto.randomUUID()}`);
const running = new Set<number>();

const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// A listed pid is only stopped while it is still a workerd, not a process that reused the pid. An
// orphaned workerd ignores SIGTERM, and has nothing left to shut down cleanly for.
const STOP_WORKERD = 'for p in $(cat "$f"); do ps -o comm= -p "$p" 2>/dev/null | grep -q workerd && kill -9 "$p"; done';

/** Stops what processes that have gone left listed, and forgets them. */
const sweepGoneProcesses = () => {
  for (const name of readdirSync(reaperDirectory)) {
    const owner = Number(name.split(".")[0]);
    if (!Number.isInteger(owner) || owner === process.pid || isRunning(owner)) continue;
    const file = path.join(reaperDirectory, name);
    if (name.includes(".workerd-")) {
      childProcess.spawnSync("/bin/sh", ["-c", STOP_WORKERD, "sh"], {
        env: { ...process.env, f: file },
        stdio: "ignore",
      });
    }
    rmSync(file, { force: true });
  }
};

const ensureWatchdog = () => {
  try {
    if (isRunning(Number(readFileSync(watchdogFile(process.pid), "utf8")))) return;
  } catch {}
  mkdirSync(reaperDirectory, { recursive: true });
  sweepGoneProcesses();
  const script =
    'while kill -0 "$1" 2>/dev/null; do sleep 1; done; ' +
    `for f in "$2"/"$1".workerd-*; do [ -f "$f" ] && { ${STOP_WORKERD}; rm -f "$f"; }; done; rm -f "$2/$1.watchdog"`;
  const watchdog = childProcess.spawn("/bin/sh", ["-c", script, "sh", String(process.pid), reaperDirectory], {
    detached: true,
    stdio: "ignore",
  });
  watchdog.unref();
  if (watchdog.pid !== undefined) writeFileSync(watchdogFile(process.pid), String(watchdog.pid));
};

/** Lists a workerd process until it exits, so it is stopped if this process ends first. */
export const reapWithThisProcess = (child: childProcess.ChildProcess) => {
  if (process.platform === "win32" || child.pid === undefined) return;
  ensureWatchdog();
  const pid = child.pid;
  running.add(pid);
  appendFileSync(pidFile, `${pid}\n`);
  child.once("exit", () => {
    running.delete(pid);
    if (running.size === 0) rmSync(pidFile, { force: true });
    else writeFileSync(pidFile, [...running].map((listed) => `${listed}\n`).join(""));
  });
};
