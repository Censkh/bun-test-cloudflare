import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { HarnessRun } from "../../../src/HarnessRun";

// Preload: records each runtime the harness starts, one line per runtime, and the pid of each
// workerd process spawned for them, one line per process.
const started = new WeakSet<object>();
const start = HarnessRun.prototype.start;
HarnessRun.prototype.start = function (this: HarnessRun<any>) {
  if (!started.has(this)) {
    started.add(this);
    appendFileSync(process.env.BTCF_RUNTIME_START_LOG!, "started\n");
  }
  return start.call(this);
};

const spawn = childProcess.spawn;
childProcess.spawn = function (this: unknown, command: string, ...rest: unknown[]) {
  const child = (spawn as (...args: unknown[]) => childProcess.ChildProcess).call(this, command, ...rest);
  if (path.basename(command).includes("workerd") && child.pid !== undefined) {
    appendFileSync(process.env.BTCF_WORKERD_PID_LOG!, `${child.pid}\n`);
  }
  return child;
} as typeof childProcess.spawn;
