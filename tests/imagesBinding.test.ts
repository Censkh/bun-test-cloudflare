import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "images-binding");

describe("Images binding fixture", () => {
  test("captures backend-like unsupported HEIF output", () => {
    const result = runBunFixture(fixtureRoot, { logOutput: true, timeoutMs: 15_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(1);
    expect(output).toContain("Unsupported image type heif");
    expect(output).not.toContain("WritableStreamDefaultWriter has no stream");
  }, 20_000);
});
