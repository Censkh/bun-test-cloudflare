import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "cache-bridge");

const fixture = bunFixtureTest(fixtureRoot);

describe("Cache bridge fixture", () => {
  fixture.test(
    "shares runtime caches across Bun and Worker code",
    ({ run }) => {
      const result = run({ timeoutMs: 15_000 });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("globalThis.caches is not installed");
    },
    20_000,
  );
});
