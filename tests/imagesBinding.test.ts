import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "images-binding");

describe("Images binding fixture", () => {
  test("captures backend-like Images binding behavior", () => {
    const result = runBunFixture(fixtureRoot, { timeoutMs: 15_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("WritableStreamDefaultWriter has no stream");
  }, 20_000);
});
