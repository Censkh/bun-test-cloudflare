import { expect, test } from "bun:test";
import { harness } from "./workerHarness";

// Counts the blocking waits Miniflare's synchronous proxy calls make while test code queries D1.
const countBlockingWaits = async (callback: () => Promise<void>) => {
  const originalWait = Atomics.wait;
  let waits = 0;
  Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
    waits += 1;
    return originalWait(...args);
  }) as typeof Atomics.wait;
  try {
    await callback();
  } finally {
    Atomics.wait = originalWait;
  }
  return waits;
};

test("D1 queries from test code block only to prepare and bind their statements", async () => {
  await harness.run(async (workers) => {
    const env = await workers.CMS.getEnv<{ DB: D1Database }>();
    await env.DB.prepare("SELECT ? AS value").bind(0).all();

    const queries = 10;
    let total = 0;
    const waits = await countBlockingWaits(async () => {
      for (let index = 0; index < queries; index++) {
        const { results } = await env.DB.prepare("SELECT ? AS value").bind(index).all<{ value: number }>();
        total += results[0]!.value;
      }
    });

    expect(total).toBe(45);
    // Preparing and binding each return a statement at once, so each waits for workerd; running
    // it is async. Learning `all` per statement instead added two more waits per query.
    expect(waits).toBeLessThanOrEqual(queries * 2);
  });
});
