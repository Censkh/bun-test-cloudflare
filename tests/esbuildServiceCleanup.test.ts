import { test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "esbuild-service-cleanup");

test("stops Wrangler esbuild services after harness teardown", () => {
  const result = runBunFixture(fixtureRoot, { timeoutMs: 20_000 });

  result.expectStatusCode(0);
});
