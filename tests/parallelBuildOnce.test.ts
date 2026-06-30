import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-build-once");
const buildLogPath = path.join(fixtureRoot, "node_modules/.btcf/parallel-build-once/builds.log");

describe("parallel worker builds", () => {
  test("runs the Wrangler dry-run build once across parallel Bun workers", () => {
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
