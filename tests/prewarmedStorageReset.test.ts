import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "prewarmed-storage-reset");
const fixture = bunFixtureTest(fixtureRoot);

describe("prewarmed harness storage reset", () => {
  fixture.test(
    "rotates isolated Workers and resets their generation",
    ({ run }) => {
      const result = run({
        env: {
          BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP: "1",
          BUN_TEST_CLOUDFLARE_TIMINGS: "1",
          BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS: "60000",
        },
        logOutput: true,
        processTimeoutMs: 65_000,
        testArgs: ["--no-orphans"],
        timeoutMs: 60_000,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("discarded prewarmed server during reset");
      expect(output).toContain("reset:slot");
      expect(output).toContain("reset:generation");
    },
    75_000,
  );
});
