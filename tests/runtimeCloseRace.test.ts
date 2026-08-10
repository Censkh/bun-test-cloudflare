import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "runtime-close-race");
const fixtureTimeoutMs = 30_000;
const testTimeoutMs = 45_000;

describe("runtime close race repro", () => {
  test(
    "closes after platform proxy dispatches settle",
    () => {
      const result = runBunFixture(fixtureRoot, {
        testArgs: ["--parallel=1", "--parallel-delay=0"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("timed out");
      expect(output).not.toContain("killed 1 dangling process");
    },
    testTimeoutMs,
  );
});
