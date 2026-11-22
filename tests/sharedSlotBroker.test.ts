import { describe, expect, test } from "bun:test";
import { parseParallelCountFromArgs } from "../src/SharedSlotBroker";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

test("reads Bun's --parallel worker count from its command line", () => {
  expect(parseParallelCountFromArgs("bun test --parallel=3 --no-isolate")).toBe(3);
  expect(parseParallelCountFromArgs("bun test --parallel 5 src")).toBe(5);
  expect(parseParallelCountFromArgs("bun test src")).toBeUndefined();
  expect(parseParallelCountFromArgs("bun test --parallel=0")).toBeUndefined();
});

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "shared-slot-broker"));

describe("shared slot broker", () => {
  fixture.test(
    "parallel test processes lease isolated slots from one broker sized for them",
    ({ run }) => {
      const result = run({
        env: { BUN_TEST_CLOUDFLARE_TIMINGS: "1" },
        fixtureTests: ["./sharedSlotA.fixture.ts", "./sharedSlotB.fixture.ts", "./sharedSlotC.fixture.ts"],
        testArgs: ["--parallel=3", "--parallel-delay=0"],
        timeoutMs: 120_000,
      });

      result.expectStatusCode(0);
      const connections = [...result.stderr.matchAll(/shared-broker connected pid=(\d+) slots=(\d+) worker=(\S+)/g)];
      // One connection from each of the three test processes, all to the same broker, which
      // holds a slot for every two of them (rounded up), and the harness's own two at least.
      expect(new Set(connections.map(([, , , worker]) => worker)).size).toBe(3);
      expect(new Set(connections.map(([, pid]) => pid)).size).toBe(1);
      expect(new Set(connections.map(([, , slots]) => slots))).toEqual(new Set(["2"]));
    },
    180_000,
  );

  fixture.test(
    "a run whose test times out gives its slot back as the test ends",
    ({ run }) => {
      const result = run({
        // Its own broker of two slots for a single test process.
        env: { BUN_TEST_CLOUDFLARE_SHARED_SLOTS: "2" },
        fixtureTests: ["./sharedSlotTimeout.fixture.ts"],
        timeoutMs: 30_000,
      });
      // The three tests that time out fail, one before its run starts; the run after them passes.
      result.expectStatusCode(1);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toMatch(/^ 1 pass$/m);
      expect(output).toMatch(/^ 3 fail$/m);
    },
    180_000,
  );

  fixture.test(
    "a broker that stops is replaced for the next run",
    ({ run }) => {
      const result = run({
        // Its own broker for a single test process, which is otherwise only used with --parallel.
        env: { BUN_TEST_CLOUDFLARE_SHARED_SLOTS: "2" },
        fixtureTests: ["./sharedSlotRestart.fixture.ts"],
        timeoutMs: 120_000,
      });
      result.expectStatusCode(0);
    },
    180_000,
  );
});
