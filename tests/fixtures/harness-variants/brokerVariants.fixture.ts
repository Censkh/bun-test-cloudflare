import { expect, test } from "bun:test";
import { harness } from "./harness";

test("overlapping broker leases activate with their own vars and queue settings", async () => {
  const held = await harness.with({ vars: { WORKER: { GREETING: "held" } }, consumeQueues: false }).lease();
  try {
    await harness.with({ vars: { WORKER: { GREETING: "sent" } } }).run(async ({ WORKER }) => {
      const responses = await Promise.all([
        held.run(async ({ WORKER }) => {
          const env = await WORKER.getEnv();
          await WORKER.fetch("https://example.test/send?value=held");
          return [env.GREETING, await (await WORKER.fetch("https://example.test/greeting")).json()];
        }),
        (async () => {
          await WORKER.fetch("https://example.test/send?value=sent");
          const env = await WORKER.getEnv();
          const deadline = Date.now() + 10_000;
          while ((await env.KV.get("consumed:sent")) === null && Date.now() < deadline) await Bun.sleep(50);
          expect(await env.KV.get("consumed:sent")).toBe("1");
          return [env.GREETING, await (await WORKER.fetch("https://example.test/greeting")).json()];
        })(),
      ]);
      expect(responses).toEqual([
        ["held", { greeting: "held" }],
        ["sent", { greeting: "sent" }],
      ]);
      await held.run(async ({ WORKER }) => expect(await (await WORKER.getEnv()).KV.get("consumed:held")).toBeNull());
    });
  } finally {
    await held.release();
  }
});
