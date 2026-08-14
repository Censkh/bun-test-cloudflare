import { test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "wrangler-start-timeout-repro");
const fixtureTimeoutMs = 20_000;
const testTimeoutMs = 30_000;

const runFixture = (env: Record<string, string> = {}) => {
  return runBunFixture(fixtureRoot, {
    env,
    testArgs: ["--no-orphans", "--max-concurrency=1"],
    timeoutMs: fixtureTimeoutMs,
  });
};

test(
  "Wrangler can restart after an abandoned harness run",
  () => {
    const result = runFixture();

    result.expectStatusCode(0);
  },
  testTimeoutMs,
);
