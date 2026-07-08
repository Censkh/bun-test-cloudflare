import { expect, test } from "bun:test";
import { PrewarmedServerOrchestrator, WARM_WORKERD_POOL_SIZE } from "../src/PrewarmedServerOrchestrator";

test("prewarmed server cleanup waits for starting runs before closing them", async () => {
  const events: string[] = [];
  let createdRuns = 0;
  let resolveStarts: (() => void) | undefined;
  const starts = new Promise<void>((resolve) => {
    resolveStarts = resolve;
  });
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      close: async () => {
        events.push(`closed:${runId}`);
      },
      start: async () => {
        await starts;
        events.push(`started:${runId}`);
      },
    } as any;
  });

  const closePromise = orchestrator.close();
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(events).toEqual([]);

  resolveStarts?.();
  await closePromise;

  expect(createdRuns).toBe(WARM_WORKERD_POOL_SIZE);
  for (let index = 0; index < WARM_WORKERD_POOL_SIZE; index++) {
    expect(events.indexOf(`started:${index}`)).toBeLessThan(events.indexOf(`closed:${index}`));
  }
});
