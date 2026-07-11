import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const removeFixtureBuildStatuses = (fixtureRoot: string) => {
  const buildRoot = path.join(fixtureRoot, "node_modules/.btcf/worker-build");
  for (const entry of readdirSync(buildRoot)) {
    if (/\.build-\d+\.json$/.test(entry)) {
      unlinkSync(path.join(buildRoot, entry));
    }
  }
};

const findNestedHarnessBuildDirectories = (fixtureRoot: string) => {
  const buildRoot = path.join(fixtureRoot, "node_modules/.btcf/worker-build");
  const nestedBuildDirectories: string[] = [];

  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (!entry.isDirectory()) {
        continue;
      }

      const relativePath = path.relative(buildRoot, entryPath).split(path.sep);
      if (relativePath.includes("node_modules") && relativePath.includes(".btcf")) {
        nestedBuildDirectories.push(path.relative(fixtureRoot, entryPath));
        continue;
      }

      visit(entryPath);
    }
  };

  visit(buildRoot);
  return nestedBuildDirectories;
};

describe("surfaced issue repro fixtures", () => {
  test("global caches access outside harness.run does not fail during module evaluation", () => {
    const result = runBunFixture(fixturePath(import.meta.dir, "global-caches-outside-run-repro"), {
      timeoutMs: 15_000,
    });

    result.expectStatusCode(0);
  });

  test("runtime dynamic imports are available from built Worker modules through service bindings", () => {
    const fixtureRoot = fixturePath(import.meta.dir, "service-binding-missing-module-repro");
    rmSync(path.join(fixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

    const firstResult = runBunFixture(fixtureRoot, {
      installMode: "full",
      timeoutMs: 20_000,
    });
    firstResult.expectStatusCode(0);

    removeFixtureBuildStatuses(fixtureRoot);
    const secondResult = runBunFixture(fixtureRoot, {
      installMode: "full",
      timeoutMs: 20_000,
    });
    secondResult.expectStatusCode(0);
    expect(findNestedHarnessBuildDirectories(fixtureRoot)).toEqual([]);
  }, 30_000);

  test("shared prewarmed harness remains usable across fixture files", () => {
    const result = runBunFixture(fixturePath(import.meta.dir, "shared-harness-closed-repro"), {
      testArgs: ["--max-concurrency=1"],
      timeoutMs: 20_000,
    });

    result.expectStatusCode(0);
  }, 30_000);
});
