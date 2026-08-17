import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "images-binding");

const fixture = bunFixtureTest(fixtureRoot);

describe("Images binding fixture", () => {
  fixture.test(
    "captures backend-like Images binding behavior",
    ({ run }) => {
      const result = run({ timeoutMs: 40_000 });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("WritableStreamDefaultWriter has no stream");
    },
    45_000,
  );
});
