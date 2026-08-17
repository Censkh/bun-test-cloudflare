import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "tiktoken-wasm");

const fixture = bunFixtureTest(fixtureRoot, { installMode: "full" });

describe("Tiktoken wasm fixture", () => {
  fixture.test("passes in its own Bun test process", ({ run }) => {
    const result = run();
    result.expectStatusCode(0);
  });
});
