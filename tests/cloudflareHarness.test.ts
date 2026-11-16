import { describe, expect } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { getWorkerBuildCacheRoot } from "../src/WorkerBuildCache";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "cloudflare-harness");

const fixture = bunFixtureTest(fixtureRoot);

/** Builds kept from earlier runs, so a test that watches the build processes sees them build. */
const forgetCachedBuilds = () => rmSync(getWorkerBuildCacheRoot(fixtureRoot), { force: true, recursive: true });

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
      forgetCachedBuilds();
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
      forgetCachedBuilds();
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

  /** Two files using one shared harness, run as `testArgs` say: what started, and what is left running. */
  const runSharedHarnessFiles = (run: Parameters<Parameters<typeof fixture.test>[1]>[0]["run"], testArgs: string[]) => {
    const runtimeStartLog = path.join(fixtureRoot, "node_modules/.btcf/runtime-starts.log");
    const workerdPidLog = path.join(fixtureRoot, "node_modules/.btcf/workerd-pids.log");
    rmSync(runtimeStartLog, { force: true });
    rmSync(workerdPidLog, { force: true });
    const result = run({
      env: { BTCF_RUNTIME_START_LOG: runtimeStartLog, BTCF_WORKERD_PID_LOG: workerdPidLog },
      testArgs: [...testArgs, "--preload", "./runtimeStartLog.ts"],
      fixtureTests: ["./sharedBuild.fixture.ts", "./sharedRuntime.fixture.ts"],
      timeoutMs: 30_000,
      processTimeoutMs: 40_000,
    });
    result.expectStatusCode(0);
    const lines = (file: string) => readFileSync(file, "utf8").split("\n").filter(Boolean);
    const workerdPids = lines(workerdPidLog).map(Number);
    const isRunning = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // A runtime the run left behind is stopped by its watchdog, which checks every second.
    const deadline = Date.now() + 5_000;
    while (workerdPids.some(isRunning) && Date.now() < deadline) Bun.sleepSync(100);
    return { runtimeStarts: lines(runtimeStartLog).length, workerdPids, leftRunning: workerdPids.filter(isRunning) };
  };

  // Every way Bun can run the files: in one process or in workers, with each file in a global of
  // its own or sharing one. Files that share a global share a runtime; nothing outlives the run.
  for (const { mode, testArgs, runtimeStarts } of [
    { mode: "in one process (Bun's default)", testArgs: [], runtimeStarts: 1 },
    { mode: "in one process with --isolate", testArgs: ["--isolate"], runtimeStarts: 2 },
    { mode: "in one worker", testArgs: ["--parallel=1"], runtimeStarts: 2 },
    { mode: "in one worker with --no-isolate", testArgs: ["--parallel=1", "--no-isolate"], runtimeStarts: 1 },
    { mode: "in two workers", testArgs: ["--parallel=2", "--parallel-delay=0"], runtimeStarts: 2 },
    {
      mode: "in two workers with --no-isolate",
      testArgs: ["--parallel=2", "--parallel-delay=0", "--no-isolate"],
      // One per worker that ran a file: Bun may hand both files to one worker.
      runtimeStarts: [1, 2],
    },
  ]) {
    fixture.test(
      `test files run ${mode} start ${Array.isArray(runtimeStarts) ? "a runtime per worker" : runtimeStarts === 1 ? "one runtime between them" : "a runtime each"} and leave no workerd running`,
      ({ run }) => {
        const result = runSharedHarnessFiles(run, testArgs);
        if (Array.isArray(runtimeStarts)) expect(runtimeStarts).toContain(result.runtimeStarts);
        else expect(result.runtimeStarts).toBe(runtimeStarts);
        expect(result.workerdPids.length).toBeGreaterThanOrEqual(result.runtimeStarts);
        expect(result.leftRunning).toEqual([]);
      },
      45_000,
    );
  }

  fixture.test(
    "keeps a proxy alive for its call and lets it go afterwards",
    ({ run }) => {
      const result = run({
        fixtureTests: ["./proxyCallRetention.fixture.ts"],
        timeoutMs: 120_000,
        processTimeoutMs: 130_000,
      });
      result.expectStatusCode(0);
    },
    140_000,
  );

  fixture.test(
    "shares concurrent builds across Bun test workers",
    ({ run }) => {
      forgetCachedBuilds();
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
      forgetCachedBuilds();
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
