import { HarnessRun } from "../../../src/HarnessRun";

// Preload: counts the runtimes (harness runs) the harness creates, for the test of variants sharing one.
const start = HarnessRun.prototype.start;
const started = new WeakSet<object>();
(globalThis as { __runtimesStarted?: number }).__runtimesStarted = 0;
HarnessRun.prototype.start = function (this: HarnessRun<any>) {
  if (!started.has(this)) {
    started.add(this);
    (globalThis as { __runtimesStarted?: number }).__runtimesStarted! += 1;
  }
  return start.call(this);
};
