import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createRuntimeCrashMonitor, WORKER_RUNTIME_CRASHED } from "../src/WorkerRuntimeCrash";

const createChild = (pid: number) => {
  const child = Object.assign(new EventEmitter(), {
    pid,
    killSignals: [] as Array<NodeJS.Signals | number | undefined>,
    kill(signal?: NodeJS.Signals | number) {
      child.killSignals.push(signal);
      return true;
    },
  });
  return child;
};

const settledWithin = async (promise: Promise<unknown>) => {
  const pending = Symbol("pending");
  return Promise.race([
    promise.then(
      () => "resolved",
      (error) => error,
    ),
    Bun.sleep(10).then(() => pending),
  ]);
};

test("an exit nobody asked for is a crash that rejects the run's waits", async () => {
  const monitor = createRuntimeCrashMonitor();
  const child = createChild(41);
  monitor.track(child);

  child.emit("exit", null, "SIGTERM");

  expect(await settledWithin(monitor.crashed)).toMatchObject({
    code: WORKER_RUNTIME_CRASHED,
    exitCode: null,
    pid: 41,
    signal: "SIGTERM",
  });
  expect(() => monitor.assertAlive()).toThrow(expect.objectContaining({ code: WORKER_RUNTIME_CRASHED }));
});

test("a runtime stopped through its own kill() is not a crash, and still receives the signal", async () => {
  const monitor = createRuntimeCrashMonitor();
  const child = createChild(42);
  monitor.track(child);

  child.kill("SIGKILL");
  child.emit("exit", null, "SIGKILL");

  expect(child.killSignals).toEqual(["SIGKILL"]);
  expect(monitor.crash).toBeUndefined();
  expect(typeof (await settledWithin(monitor.crashed))).toBe("symbol");
  monitor.assertAlive();
});

test("keeps the first crash when a restarted runtime dies too", async () => {
  const monitor = createRuntimeCrashMonitor();
  const first = createChild(43);
  const restarted = createChild(44);
  monitor.track(first);
  monitor.track(restarted);

  first.emit("exit", 0, null);
  restarted.emit("exit", null, "SIGTERM");

  expect(monitor.crash).toMatchObject({ pid: 43, exitCode: 0, signal: null });
});
