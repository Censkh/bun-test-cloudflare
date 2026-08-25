import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "worker-runtime-crash");
const fixtureTimeoutMs = 15_000;
const testTimeoutMs = 30_000;

const fixture = bunFixtureTest(fixtureRoot);

describe("worker runtime crash", () => {
  fixture.test(
    "settles tests and teardown after the whole prewarmed pool crashes",
    ({ run }) => {
      const result = run({
        testArgs: ["--max-concurrency=1", "--no-orphans"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).toContain("[worker-runtime-crash] crashed workerd pool processes=");
      expect(output).not.toContain("hook timed out");
      expect(output).not.toContain("dangling process");
    },
    testTimeoutMs,
  );
});
