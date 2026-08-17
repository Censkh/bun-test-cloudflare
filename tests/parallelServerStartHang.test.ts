import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-server-start-hang");
const fixtureTimeoutMs = 45_000;
const testTimeoutMs = 60_000;

const fixture = bunFixtureTest(fixtureRoot, { installMode: "full" });

describe("parallel server start hang repro", () => {
  fixture.test(
    "starts and closes many harness runs across parallel Bun workers",
    ({ run }) => {
      const result = run({
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
