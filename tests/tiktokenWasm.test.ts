import { describe, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "tiktoken-wasm");

describe("Tiktoken wasm fixture", () => {
  test("passes in its own Bun test process", () => {
    const result = runBunFixture(fixtureRoot);
    result.expectStatusCode(0);
  }, 15_000);
});
