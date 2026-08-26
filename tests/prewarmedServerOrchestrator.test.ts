import { expect, test } from "bun:test";
import {
  PrewarmedServerOrchestrator,
  ReusableServerOrchestrator,
  WARM_WORKERD_POOL_SIZE,
} from "../src/PrewarmedServerOrchestrator";

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

test("prewarmed server cleanup bounds stuck startup waits", async () => {
  const originalTimeout = process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS;
  process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS = "10";
  const events: string[] = [];
  let createdRuns = 0;
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      close: async () => {
        events.push(`closed:${runId}`);
      },
      start: async () => {
        await new Promise(() => {});
      },
    } as any;
  });

  try {
    await orchestrator.close();
  } finally {
    if (originalTimeout === undefined) {
      delete process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS;
    } else {
      process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS = originalTimeout;
    }
  }

  expect(createdRuns).toBe(WARM_WORKERD_POOL_SIZE);
  for (let index = 0; index < WARM_WORKERD_POOL_SIZE; index++) {
    expect(events).toContain(`closed:${index}`);
  }
});

test("prewarmed server acquire skips stuck warm runs", async () => {
  const originalTimeout = process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS;
  process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS = "10";
  const events: string[] = [];
  let createdRuns = 0;
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      assertUsable: async () => {},
      close: async () => {
        events.push(`closed:${runId}`);
      },
      flushLogs: () => {},
      resetForReuse: async () => {
        events.push(`reset:${runId}`);
      },
      start: async () => {
        if (runId < WARM_WORKERD_POOL_SIZE) {
          await new Promise(() => {});
        }
        events.push(`started:${runId}`);
      },
    } as any;
  });

  try {
    const lease = await orchestrator.acquire();
    await lease.release();
  } finally {
    await orchestrator.close();
    if (originalTimeout === undefined) {
      delete process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS;
    } else {
      process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS = originalTimeout;
    }
  }

  expect(createdRuns).toBeGreaterThan(WARM_WORKERD_POOL_SIZE);
  expect(events).toContain(`started:${WARM_WORKERD_POOL_SIZE}`);
  for (let index = 0; index < WARM_WORKERD_POOL_SIZE; index++) {
    expect(events).toContain(`closed:${index}`);
  }
});

test("prewarmed server resets returned runs in the background", async () => {
  const events: string[] = [];
  let createdRuns = 0;
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      assertUsable: async () => {
        events.push(`usable:${runId}`);
      },
      canRotateWorkerSlotForReuse: () => true,
      close: async () => {},
      flushLogs: () => {},
      resetForReuse: async () => {
        events.push(`reset:${runId}`);
      },
      start: async () => {},
    } as any;
  });

  try {
    const firstLease = await orchestrator.acquire();
    await firstLease.release();
    const secondLease = await orchestrator.acquire();
    await secondLease.release();
    const thirdLease = await orchestrator.acquire();
    await thirdLease.release();
  } finally {
    await orchestrator.close();
  }

  expect(events.slice(0, 5)).toEqual(["usable:0", "reset:0", "usable:0", "reset:0", "usable:0"]);
});

test("prewarmed server release does not wait for a background reset", async () => {
  let finishReset!: () => void;
  const resetFinished = new Promise<void>((resolve) => {
    finishReset = resolve;
  });
  let createdRuns = 0;
  let resetStarted = false;
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      assertUsable: async () => {},
      close: async () => {},
      flushLogs: () => {},
      resetForReuse: async () => {
        if (runId === 0) {
          resetStarted = true;
          await resetFinished;
        }
      },
      start: async () => {},
    } as any;
  }, 2);

  try {
    const firstLease = await orchestrator.acquire();
    await firstLease.release();

    expect(resetStarted).toBe(true);
    const secondLease = await orchestrator.acquire();
    expect(secondLease.run).not.toBe(firstLease.run);
    finishReset();
    await secondLease.release();
  } finally {
    finishReset();
    await orchestrator.close();
  }
});

test("prewarmed server replaces an unusable run when its cleanup rejects", async () => {
  const events: string[] = [];
  let createdRuns = 0;
  const orchestrator = new PrewarmedServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      assertUsable: async () => {
        events.push(`usable:${runId}`);
      },
      close: async () => {
        events.push(`closed:${runId}`);
        if (runId === 0) {
          throw new Error("runtime cleanup failed");
        }
      },
      flushLogs: () => {},
      resetForReuse: async () => {
        events.push(`reset:${runId}`);
        if (runId === 0) {
          throw new Error("runtime crashed");
        }
      },
      start: async () => {},
    } as any;
  });

  try {
    const firstLease = await orchestrator.acquire();
    await firstLease.release();
    const secondLease = await orchestrator.acquire();
    await secondLease.release();
    const thirdLease = await orchestrator.acquire();
    await thirdLease.release();
  } finally {
    await orchestrator.close();
  }

  expect(events).toContain("reset:0");
  expect(events).toContain("closed:0");
  expect(events).toContain("usable:1");
});

test("reusable server leases reset one live harness instead of recreating it", async () => {
  const events: string[] = [];
  let createdRuns = 0;
  const orchestrator = new ReusableServerOrchestrator<any>(() => {
    const runId = createdRuns++;
    return {
      assertUsable: async () => {
        events.push(`usable:${runId}`);
      },
      close: async () => {
        events.push(`closed:${runId}`);
      },
      resetForReuse: async () => {
        events.push(`reset:${runId}`);
      },
      start: async () => {
        events.push(`started:${runId}`);
      },
    } as any;
  });

  try {
    const firstLease = await orchestrator.acquire();
    await firstLease.release();
    const secondLease = await orchestrator.acquire();
    await secondLease.release();
  } finally {
    await orchestrator.close();
  }

  expect(createdRuns).toBe(1);
  expect(events).toEqual(["started:0", "usable:0", "reset:0", "usable:0", "closed:0"]);
});
