import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

describe("Undici version compatibility fixtures", () => {
  for (const fixtureName of ["undici-6", "undici-7", "undici-8"]) {
    test(`setup works with ${fixtureName}`, () => {
      const result = runBunFixture(fixturePath(import.meta.dir, fixtureName), {
        installMode: "full",
        timeoutMs: 15_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("markAsUncloneable is not a function");
    }, 30_000);
  }
});
