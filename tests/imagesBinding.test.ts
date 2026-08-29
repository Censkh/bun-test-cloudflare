import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "images-binding");

const fixture = bunFixtureTest(fixtureRoot);

describe("Images binding fixture", () => {
  fixture.test(
    "captures backend-like Images binding behavior",
    ({ run }) => {
      const result = run({
        env: {
          BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP: "1",
          BUN_TEST_CLOUDFLARE_TIMINGS: "1",
        },
        logOutput: true,
        processTimeoutMs: 70_000,
        testArgs: ["--no-orphans"],
        timeoutMs: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("WritableStreamDefaultWriter has no stream");
    },
    80_000,
  );
});
