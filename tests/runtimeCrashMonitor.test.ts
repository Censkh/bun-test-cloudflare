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

  const wait = monitor.untilCrash(new Promise(() => {}));
  child.emit("exit", null, "SIGTERM");

  expect(await settledWithin(wait)).toMatchObject({
    code: WORKER_RUNTIME_CRASHED,
    exitCode: null,
    pid: 41,
    signal: "SIGTERM",
  });
  expect(() => monitor.assertAlive()).toThrow(expect.objectContaining({ code: WORKER_RUNTIME_CRASHED }));
  expect(await settledWithin(monitor.untilCrash(new Promise(() => {})))).toMatchObject({ pid: 41 });
});

test("a runtime stopped through its own kill() is not a crash, and still receives the signal", async () => {
  const monitor = createRuntimeCrashMonitor();
  const child = createChild(42);
  monitor.track(child);

  child.kill("SIGKILL");
  child.emit("exit", null, "SIGKILL");

  expect(child.killSignals).toEqual(["SIGKILL"]);
  expect(monitor.crash).toBeUndefined();
  expect(typeof (await settledWithin(monitor.untilCrash(new Promise(() => {}))))).toBe("symbol");
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

test("a wait settles with its own promise while the runtime lives", async () => {
  const monitor = createRuntimeCrashMonitor();
  monitor.track(createChild(45));

  expect(await monitor.untilCrash(Promise.resolve("value"))).toBe("value");
  expect(await monitor.untilCrash("plain value")).toBe("plain value");
  const failure = new Error("the wait's own failure");
  await expect(monitor.untilCrash(Promise.reject(failure))).rejects.toBe(failure);
});

test("a settled wait leaves its result collectable while the run lives", async () => {
  const monitor = createRuntimeCrashMonitor();
  monitor.track(createChild(46));
  const results: Array<WeakRef<object>> = [];

  await (async () => {
    for (let index = 0; index < 100; index++) {
      const result = {};
      results.push(new WeakRef(result));
      await monitor.untilCrash(Promise.resolve(result));
    }
  })();
  await Bun.sleep(0);
  Bun.gc(true);

  // The collector scans the stack conservatively, so one or two may survive this collection.
  expect(results.filter((result) => result.deref()).length).toBeLessThan(10);
});
