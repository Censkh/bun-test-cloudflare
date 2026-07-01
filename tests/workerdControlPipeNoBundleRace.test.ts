import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "workerd-control-pipe-no-bundle-race");

describe("workerd control pipe no-bundle race", () => {
  test("raw Wrangler no-bundle harness starts and closes multiworker sessions in parallel", () => {
    const result = runBunFixture(fixtureRoot, {
      testArgs: ["--parallel=12", "--parallel-delay=0"],
      timeoutMs: 20_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("ERR_RUNTIME_FAILURE");
    expect(output).not.toContain("Broken pipe");
    expect(output).not.toContain("timed out");
  }, 30_000);
});
