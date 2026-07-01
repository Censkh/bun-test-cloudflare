import { expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "wrangler-start-timeout-repro");

const runFixture = (env: Record<string, string> = {}) => {
  return runBunFixture(fixtureRoot, {
    env,
    testArgs: ["--no-orphans", "--max-concurrency=1"],
  });
};

test("timeout repro hits Wrangler guessWorkerFormat without the patch", () => {
  const result = runFixture({
    BUN_TEST_CLOUDFLARE_DISABLE_GUESS_WORKER_FORMAT_PATCH: "1",
    BUN_TEST_CLOUDFLARE_DISABLE_SERVER_PREWARM: "1",
    BUN_TEST_CLOUDFLARE_TIMEOUT_REPRO: "1",
  });
  const output = `${result.stdout}\n${result.stderr}`;

  result.expectStatusCode(1);
  expect(output).toMatch(/The service is no longer running|The service was stopped|Unable to connect|EPIPE/);
  expect(output).toMatch(/guessWorkerFormat|esbuild/);
}, 15_000);

test("Wrangler can restart after a timed-out harness run", () => {
  const result = runFixture();

  result.expectStatusCode(0);
}, 15_000);
