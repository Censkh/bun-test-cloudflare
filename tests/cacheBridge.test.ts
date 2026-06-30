import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "cache-bridge");

describe("Cache bridge fixture", () => {
  test("shares runtime caches across Bun and Worker code", () => {
    const result = runBunFixture(fixtureRoot, { timeoutMs: 15_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("globalThis.caches is not installed");
  }, 20_000);
});
