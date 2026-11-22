import { expect, test } from "bun:test";
import { harness } from "./harness";

const greetings = async (workers: Parameters<Parameters<typeof harness.run>[0]>[0]) => ({
  worker: ((await (await workers.WORKER.fetch("https://example.com/greeting")).json()) as { greeting: string })
    .greeting,
  object: ((await (await workers.WORKER.fetch("https://example.com/object-greeting")).json()) as { greeting: string })
    .greeting,
  objectProcess: (
    (await (await workers.WORKER.fetch("https://example.com/object-process-greeting")).json()) as { greeting: string }
  ).greeting,
});

const runtimesStarted = () => (globalThis as { __runtimesStarted?: number }).__runtimesStarted;

test("a variant's vars reach its Worker and its Durable Objects (env and process.env), and its harness's runs keep their own", async () => {
  const base = { worker: "base", object: "base", objectProcess: "base" };
  await harness.run(async (workers) => expect(await greetings(workers)).toEqual(base));
  await harness
    .with({ vars: { WORKER: { GREETING: "variant" } } })
    .run(async (workers) =>
      expect(await greetings(workers)).toEqual({ worker: "variant", object: "variant", objectProcess: "variant" }),
    );
  await harness.run(async (workers) => expect(await greetings(workers)).toEqual(base));
});

test("a later variant's vars are over an earlier one's", async () => {
  await harness
    .with({ vars: { WORKER: { GREETING: "first" } } })
    .with({ vars: { WORKER: { GREETING: "second" } } })
    .run(async (workers) => expect((await greetings(workers)).worker).toBe("second"));
});

const consumed = async (env: { KV: KVNamespace }, value: string, waitMs: number) => {
  const deadline = Date.now() + waitMs;
  for (;;) {
    if ((await env.KV.get(`consumed:${value}`)) !== null) return true;
    if (Date.now() > deadline) return false;
    await Bun.sleep(50);
  }
};

test("a variant that doesn't consume queues leaves its run's messages unconsumed; its harness's runs consume theirs", async () => {
  await harness.with({ consumeQueues: false }).run(async (workers) => {
    await workers.WORKER.fetch("https://example.com/send?value=held");
    expect(await consumed(await workers.WORKER.getEnv(), "held", 2_000)).toBe(false);
  });
  await harness.run(async (workers) => {
    await workers.WORKER.fetch("https://example.com/send?value=sent");
    expect(await consumed(await workers.WORKER.getEnv(), "sent", 10_000)).toBe(true);
  });
});

test("a variant can leave one Worker's queues unconsumed, by its key", async () => {
  await harness.with({ consumeQueues: { WORKER: false } }).run(async (workers) => {
    await workers.WORKER.fetch("https://example.com/send?value=held-by-key");
    expect(await consumed(await workers.WORKER.getEnv(), "held-by-key", 2_000)).toBe(false);
  });
});

test("variants made in a test share their harness's runtime", async () => {
  await harness.run(async () => {});
  const before = runtimesStarted();
  for (const greeting of ["one", "two", "three"])
    await harness
      .with({ vars: { WORKER: { GREETING: greeting } }, consumeQueues: false })
      .run(async (workers) => expect((await greetings(workers)).worker).toBe(greeting));
  expect(runtimesStarted()).toBe(before);
});
