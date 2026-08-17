import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

describe("Undici version compatibility fixtures", () => {
  for (const fixtureName of ["undici-6", "undici-7", "undici-8"]) {
    const fixtureRoot = fixturePath(import.meta.dir, fixtureName);
    const fixture = bunFixtureTest(fixtureRoot, { installMode: "full" });

    fixture.test(
      `setup works with ${fixtureName}`,
      ({ run }) => {
        const result = run({ timeoutMs: 15_000 });
        const output = `${result.stdout}\n${result.stderr}`;

        result.expectStatusCode(0);
        expect(output).not.toContain("markAsUncloneable is not a function");
      },
      30_000,
    );
  }
});
