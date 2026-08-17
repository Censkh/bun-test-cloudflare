import { describe, expect } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-build-reused-owner");
const buildLogPath = path.join(fixtureRoot, "node_modules/.btcf/parallel-build-reused-owner/builds.log");

const fixture = bunFixtureTest(fixtureRoot);

describe("parallel worker owner reuse", () => {
  fixture.test("does not rebuild when worker 1 imports the same harness for another test file", ({ run }) => {
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
