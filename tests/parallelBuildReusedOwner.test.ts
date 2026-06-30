import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-build-reused-owner");
const buildLogPath = path.join(fixtureRoot, "node_modules/.btcf/parallel-build-reused-owner/builds.log");

describe("parallel worker owner reuse", () => {
  test("does not rebuild when worker 1 imports the same harness for another test file", () => {
    rmSync(path.join(fixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

    const result = runBunFixture(fixtureRoot, {
      testArgs: ["--parallel=2", "--parallel-delay=0"],
      timeoutMs: 15_000,
    });

    result.expectStatusCode(0);
    const builds = readFileSync(buildLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(builds).toHaveLength(1);
  });
});
