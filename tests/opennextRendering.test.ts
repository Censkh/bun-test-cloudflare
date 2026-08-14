import { describe, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "opennext-rendering");

describe("OpenNext rendering fixture", () => {
  test.skip("waits for the upstream Cache Components workerd scheduler fix", () => {
    const result = runBunFixture(fixtureRoot, { installMode: "full", timeoutMs: 120_000 });
    result.expectStatusCode(0);
  }, 150_000);
});
