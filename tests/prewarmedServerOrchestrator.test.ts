import { expect, test } from "bun:test";
import { PrewarmedServerOrchestrator, WARM_WORKERD_POOL_SIZE } from "../src/PrewarmedServerOrchestrator";

test("prewarmed server cleanup closes runs that are still starting", async () => {
  const closedRuns: number[] = [];
  let createdRuns = 0;
  const neverStarted = new Promise<void>(() => {});
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      close: async () => {
        closedRuns.push(runId);
      },
      start: () => neverStarted,
    } as any;
  });

  await Promise.race([
    orchestrator.close(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("orchestrator close timed out")), 100)),
  ]);

  expect(createdRuns).toBe(WARM_WORKERD_POOL_SIZE);
  expect(closedRuns.toSorted()).toEqual(Array.from({ length: WARM_WORKERD_POOL_SIZE }, (_, index) => index));
});
