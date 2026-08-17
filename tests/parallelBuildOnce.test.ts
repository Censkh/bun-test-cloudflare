import { describe, expect } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-build-once");
const buildLogPath = path.join(fixtureRoot, "node_modules/.btcf/parallel-build-once/builds.log");

const fixture = bunFixtureTest(fixtureRoot);

describe("parallel worker builds", () => {
  fixture.test("builds from a nested test process that inherits a non-owner worker id", ({ run }) => {
    rmSync(path.join(fixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

    const result = run({
      env: { BUN_TEST_WORKER_ID: "2" },
      fixtureTests: ["./parallelBuildOnceA.fixture.ts"],
      timeoutMs: 15_000,
    });

    result.expectStatusCode(0);
    const builds = readFileSync(buildLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(builds).toHaveLength(1);
  });

  fixture.test("runs the Wrangler dry-run build once across parallel Bun workers", ({ run }) => {
    rmSync(path.join(fixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

    const result = run({
      testArgs: ["--parallel=2", "--parallel-delay=0"],
      timeoutMs: 15_000,
    });

    result.expectStatusCode(0);
    const builds = readFileSync(buildLogPath, "utf8").trim().split("\n").filter(Boolean);
    expect(builds).toHaveLength(1);
  });
});
