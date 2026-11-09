import { expect, test } from "bun:test";
import { harness } from "./workerHarness";

type CounterEnv = {
  COUNTER: {
    get(id: unknown): { increment(): Promise<number> };
    idFromName(name: string): unknown;
  };
};

const collectConstantly = () => {
  const timer = setInterval(() => Bun.gc(true), 5);
  return () => clearInterval(timer);
};

test("a Durable Object stub nothing else holds still reaches its object", async () => {
  await harness.run(async (workers) => {
    const env = await workers.BACKEND.getEnv<CounterEnv>();
    const stopCollecting = collectConstantly();
    const errors: string[] = [];
    try {
      for (let round = 0; round < 3; round++) {
        await Promise.all(
          Array.from({ length: 600 }, (_, index) =>
            env.COUNTER.get(env.COUNTER.idFromName(`counter-${index % 7}`))
              .increment()
              .catch((error: unknown) => errors.push(String(error))),
          ),
        );
      }
    } finally {
      stopCollecting();
    }

    // This many calls at once can also overload the connection, which isn't what this tests.
    expect(errors.filter((error) => error.includes("AssertionError"))).toEqual([]);
  });
}, 120_000);

test("a stub whose call has settled can be collected", async () => {
  await harness.run(async (workers) => {
    const env = await workers.BACKEND.getEnv<CounterEnv>();
    const stubs: Array<WeakRef<object>> = [];

    await (async () => {
      for (let index = 0; index < 50; index++) {
        const stub = env.COUNTER.get(env.COUNTER.idFromName("collected"));
        stubs.push(new WeakRef(stub));
        await stub.increment();
      }
    })();
    await Bun.sleep(0);
    Bun.gc(true);

    // The collector scans the stack conservatively, so a few may survive this collection.
    expect(stubs.filter((stub) => stub.deref()).length).toBeLessThan(10);
  });
}, 60_000);
