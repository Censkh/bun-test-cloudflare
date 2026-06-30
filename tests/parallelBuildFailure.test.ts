import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-build-failure");
const buildLogPath = path.join(fixtureRoot, "node_modules/.btcf/parallel-build-failure/builds.log");

describe("parallel worker build failures", () => {
  test("runs the failing build once and reports the same failure to waiting workers", () => {
    rmSync(path.join(fixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

    const result = runBunFixture(fixtureRoot, {
      testArgs: ["--parallel=2", "--parallel-delay=0"],
      timeoutMs: 15_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(1);
    expect(output).toContain("fixture build failed intentionally");
    expect(output).not.toContain("Timed out waiting");
    expect(existsSync(buildLogPath)).toBe(true);
    const builds = readFileSync(buildLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(builds).toHaveLength(1);
  });
});
