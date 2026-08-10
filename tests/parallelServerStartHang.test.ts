import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-server-start-hang");
const fixtureTimeoutMs = 45_000;
const testTimeoutMs = 60_000;

describe("parallel server start hang repro", () => {
  test(
    "starts and closes many harness runs across parallel Bun workers",
    () => {
      const result = runBunFixture(fixtureRoot, {
        installMode: "full",
        testArgs: ["--parallel=6", "--parallel-delay=0"],
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
