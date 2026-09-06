import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "images-binding");

const fixture = bunFixtureTest(fixtureRoot);
const fixtureTimeoutMs = 180_000;
const processTimeoutMs = 210_000;
const testTimeoutMs = 240_000;

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
        processTimeoutMs,
        testArgs: ["--no-orphans"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("WritableStreamDefaultWriter has no stream");
    },
    testTimeoutMs,
  );
});
