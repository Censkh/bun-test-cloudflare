import { describe, expect } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "cloudflare-harness");

const fixture = bunFixtureTest(fixtureRoot);

describe("Cloudflare harness fixture", () => {
  fixture.test(
    "passes in its own Bun test process",
    ({ run }) => {
      const result = run({ fixtureTests: ["./cloudflareHarness.fixture.ts", "./sharedBuild.fixture.ts"] });
      result.expectStatusCode(0);
    },
    45_000,
  );

  fixture.test(
    "builds independent Workers concurrently",
    ({ run }) => {
      const barrier = path.join(fixtureRoot, "node_modules/.btcf/build-barrier");
      rmSync(barrier, { force: true, recursive: true });
      const result = run({
        fixtureTests: ["./cloudflareHarness.fixture.ts"],
        env: {
          BUN_TEST_CLOUDFLARE_WRANGLER_PRELOADS: path.join(fixtureRoot, "buildBarrier.ts"),
          BTCF_BUILD_BARRIER_DIR: barrier,
        },
        timeoutMs: 30_000,
        processTimeoutMs: 40_000,
      });
      result.expectStatusCode(0);
      expect(readFileSync(path.join(barrier, "backend"), "utf8")).toBe("started\n");
      expect(readFileSync(path.join(barrier, "cms"), "utf8")).toBe("started\n");
    },
    45_000,
  );

  fixture.test(
    "reuses a finished build in later test files without starting a build process",
    ({ run }) => {
      const buildProcessLog = path.join(fixtureRoot, "node_modules/.btcf/build-processes.log");
      rmSync(buildProcessLog, { force: true });
      const result = run({
        env: { BTCF_BUILD_PROCESS_LOG: buildProcessLog },
        // Each isolated file creates the harness again, as a suite's later test files do.
        testArgs: ["--isolate", "--preload", "./buildProcessLog.ts"],
        fixtureTests: ["./cloudflareHarness.fixture.ts", "./sharedBuild.fixture.ts"],
        timeoutMs: 30_000,
        processTimeoutMs: 40_000,
      });
      result.expectStatusCode(0);
      expect(readFileSync(buildProcessLog, "utf8")).toBe("started\n");
    },
    45_000,
  );

  fixture.test(
    "runs D1 queries from test code without blocking lookups per statement",
    ({ run }) => {
      const result = run({ fixtureTests: ["./proxyQueries.fixture.ts"], timeoutMs: 30_000 });
      result.expectStatusCode(0);
    },
    45_000,
  );

  fixture.test(
    "shares concurrent builds across Bun test workers",
    ({ run }) => {
      const barrier = path.join(fixtureRoot, "node_modules/.btcf/shared-build-barrier");
      rmSync(barrier, { force: true, recursive: true });
      const result = run({
        env: {
          BUN_TEST_CLOUDFLARE_WRANGLER_PRELOADS: path.join(fixtureRoot, "buildBarrier.ts"),
          BTCF_BUILD_BARRIER_DIR: barrier,
        },
        testArgs: ["--parallel=2", "--parallel-delay=0"],
        fixtureTests: ["./cloudflareHarness.fixture.ts", "./sharedBuild.fixture.ts"],
        timeoutMs: 30_000,
        processTimeoutMs: 40_000,
      });
      result.expectStatusCode(0);
      expect(readFileSync(path.join(barrier, "backend"), "utf8")).toBe("started\n");
      expect(readFileSync(path.join(barrier, "cms"), "utf8")).toBe("started\n");
    },
    45_000,
  );

  fixture.test(
    "shares a concurrent build failure across Bun test workers",
    ({ run }) => {
      const barrier = path.join(fixtureRoot, "node_modules/.btcf/failed-build-barrier");
      rmSync(barrier, { force: true, recursive: true });
      const result = run({
        env: {
          BUN_TEST_CLOUDFLARE_WRANGLER_PRELOADS: path.join(fixtureRoot, "buildBarrier.ts"),
          BTCF_BUILD_BARRIER_DIR: barrier,
          BTCF_BUILD_BARRIER_FAIL: "backend",
        },
        testArgs: ["--parallel=2", "--parallel-delay=0"],
        fixtureTests: ["./cloudflareHarness.fixture.ts", "./sharedBuild.fixture.ts"],
        timeoutMs: 30_000,
        processTimeoutMs: 40_000,
      });
      result.expectStatusCode(1);
      expect(readFileSync(path.join(barrier, "backend"), "utf8")).toBe("started\n");
      expect(readFileSync(path.join(barrier, "cms"), "utf8")).toBe("started\n");
    },
    45_000,
  );

  fixture.test(
    "resolves a later Worker config created by an earlier custom build",
    ({ run }) => {
      const result = run({ fixtureTests: ["./customBuildOrder.fixture.ts"], timeoutMs: 30_000 });
      result.expectStatusCode(0);
    },
    45_000,
  );
});
