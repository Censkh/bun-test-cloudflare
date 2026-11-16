import childProcess from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { reapWithThisProcess } from "../../src/WorkerdReaper";

// A process that starts a stand-in workerd (`argv[2]`, a copy of Bun named workerd), lists it
// with the reaper and prints its pid and the watchdog's, then dies without stopping it, as Bun
// ends a test worker. With `kill-watchdog`, it kills the watchdog first, as Bun does to an
// isolated file's child processes.
const [workerd, mode] = process.argv.slice(2);
const child = childProcess.spawn(workerd!, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore", detached: true });
child.unref();
reapWithThisProcess(child);
const watchdog = Number(
  readFileSync(path.join(os.tmpdir(), "bun-test-cloudflare-reaper", `${process.pid}.watchdog`), "utf8"),
);
if (mode === "kill-watchdog") process.kill(watchdog, "SIGKILL");
console.log(JSON.stringify({ workerd: child.pid, watchdog }));
process.kill(process.pid, "SIGKILL");
