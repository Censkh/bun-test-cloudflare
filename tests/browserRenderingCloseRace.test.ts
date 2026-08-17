import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "browser-rendering-close-race");
const fixtureTimeoutMs = 30_000;
const testTimeoutMs = 45_000;

const fixture = bunFixtureTest(fixtureRoot, { installMode: "full" });

describe("Browser Rendering close race", () => {
  fixture.test(
    "closes active Browser Rendering sessions before Miniflare shutdown",
    ({ run }) => {
      const result = run({
        env: {
          BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP: "1",
        },
        fixtureTests: ["./browserRenderingLeakedSession.fixture.ts"],
        testArgs: ["--parallel=1"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).toContain("closing 1 Browser Rendering session(s)");
      expect(output).not.toContain("Not all browser processes were closed");
      expect(output).not.toContain("killed ");
      expect(output).not.toContain("timed out");
    },
    testTimeoutMs,
  );

  fixture.test(
    "does not remove Browser Rendering profile directories while launches are in flight",
    ({ run }) => {
      const result = run({
        testArgs: ["--parallel=4", "--parallel-delay=0"],
        timeoutMs: fixtureTimeoutMs,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      result.expectStatusCode(0);
      expect(output).not.toContain("Failed to launch the browser process");
      expect(output).not.toContain("SingletonLock");
      expect(output).not.toContain("ERR_RUNTIME_FAILURE");
      expect(output).not.toContain("Not all browser processes were closed");
      expect(output).not.toContain("timed out");
    },
    testTimeoutMs,
  );
});
