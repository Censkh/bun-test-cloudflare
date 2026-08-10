import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-lifecycle-hang");
const fixtureTimeoutMs = 30_000;
const testTimeoutMs = 45_000;

describe("parallel harness lifecycle", () => {
  test(
    "starts and closes backend-shaped workers across parallel Bun workers",
    () => {
      const result = runBunFixture(fixtureRoot, {
        testArgs: ["--parallel=12", "--parallel-delay=0"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("ERR_RUNTIME_FAILURE");
      expect(output).not.toContain("timed out");
    },
    testTimeoutMs,
  );
});
