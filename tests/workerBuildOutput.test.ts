import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkerBuildOutdir, getWorkerBuildRoot, removeFinishedRunBuilds } from "../src/WorkerBuildOutput";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-build-output-"));

afterAll(() => {
  rmSync(testRoot, { force: true, recursive: true });
});

test("concurrent runs and distinct build configs get separate output directories", () => {
  const firstRun = getWorkerBuildOutdir(testRoot, "100", "backend", "a".repeat(64));
  const secondRun = getWorkerBuildOutdir(testRoot, "200", "backend", "a".repeat(64));
  const otherConfig = getWorkerBuildOutdir(testRoot, "100", "backend", "b".repeat(64));

  expect(new Set([firstRun, secondRun, otherConfig]).size).toBe(3);
  expect(getWorkerBuildOutdir(testRoot, "100", "backend", "a".repeat(64))).toBe(firstRun);
  for (const outdir of [firstRun, secondRun, otherConfig]) {
    expect(path.dirname(path.dirname(outdir))).toBe(getWorkerBuildRoot(testRoot));
  }
});

test("worker names cannot escape the run directory", () => {
  const outdir = getWorkerBuildOutdir(testRoot, "100", "../../escape/worker", "c".repeat(64));

  expect(path.dirname(outdir)).toBe(path.join(getWorkerBuildRoot(testRoot), "run-100"));
});

test("removes output from finished runs and keeps live runs and unrelated entries", () => {
  const base = path.join(testRoot, "cleanup");
  const finished = getWorkerBuildOutdir(base, "111", "backend", "d".repeat(64));
  const live = getWorkerBuildOutdir(base, "222", "backend", "d".repeat(64));
  const legacy = path.join(getWorkerBuildRoot(base), "backend/worker.js");
  for (const filePath of [path.join(finished, "worker.js"), path.join(live, "worker.js"), legacy]) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, "export default {};");
  }

  removeFinishedRunBuilds(base, (runKey) => runKey === 222);

  expect(existsSync(path.join(getWorkerBuildRoot(base), "run-111"))).toBe(false);
  expect(existsSync(path.join(live, "worker.js"))).toBe(true);
  expect(existsSync(legacy)).toBe(true);
});

test("cleanup tolerates a missing build root", () => {
  const base = path.join(testRoot, "never-built");

  removeFinishedRunBuilds(base, () => false);

  expect(existsSync(getWorkerBuildRoot(base))).toBe(false);
});
