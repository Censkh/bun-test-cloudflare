import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "runtime-close-race");
const fixtureTimeoutMs = 30_000;
const testTimeoutMs = 45_000;

const fixture = bunFixtureTest(fixtureRoot);

describe("runtime close race repro", () => {
  fixture.test(
    "closes after platform proxy dispatches settle",
    ({ run }) => {
      const result = run({
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
