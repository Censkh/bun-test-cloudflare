import { describe, expect } from "bun:test";
import { readdirSync, rmSync, unlinkSync } from "node:fs";
import path from "node:path";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const serviceBindingFixtureTimeoutMs = 30_000;
const serviceBindingTestTimeoutMs = 75_000;
const sharedHarnessFixtureTimeoutMs = 30_000;
const sharedHarnessTestTimeoutMs = 45_000;
const globalCachesFixtureRoot = fixturePath(import.meta.dir, "global-caches-outside-run-repro");
const serviceBindingFixtureRoot = fixturePath(import.meta.dir, "service-binding-missing-module-repro");
const sharedHarnessFixtureRoot = fixturePath(import.meta.dir, "shared-harness-closed-repro");

const globalCachesFixture = bunFixtureTest(globalCachesFixtureRoot);
const serviceBindingFixture = bunFixtureTest(serviceBindingFixtureRoot, { installMode: "full" });
const sharedHarnessFixture = bunFixtureTest(sharedHarnessFixtureRoot);

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
  globalCachesFixture.test(
    "global caches access outside harness.run does not fail during module evaluation",
    ({ run }) => {
      const result = run({ timeoutMs: 15_000 });

      result.expectStatusCode(0);
    },
  );

  serviceBindingFixture.test(
    "runtime dynamic imports are available from built Worker modules through service bindings",
    ({ run }) => {
      rmSync(path.join(serviceBindingFixtureRoot, "node_modules/.btcf"), { force: true, recursive: true });

      const firstResult = run({ timeoutMs: serviceBindingFixtureTimeoutMs });
      firstResult.expectStatusCode(0);

      removeFixtureBuildStatuses(serviceBindingFixtureRoot);
      const secondResult = run({ timeoutMs: serviceBindingFixtureTimeoutMs });
      secondResult.expectStatusCode(0);
      expect(findNestedHarnessBuildDirectories(serviceBindingFixtureRoot)).toEqual([]);
    },
    serviceBindingTestTimeoutMs,
  );

  sharedHarnessFixture.test(
    "shared prewarmed harness remains usable across fixture files",
    ({ run }) => {
      const result = run({
        testArgs: ["--max-concurrency=1"],
        timeoutMs: sharedHarnessFixtureTimeoutMs,
      });

      result.expectStatusCode(0);
    },
    sharedHarnessTestTimeoutMs,
  );
});
