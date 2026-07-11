import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "browser-rendering-close-race");

describe("Browser Rendering close race", () => {
  test("closes active Browser Rendering sessions before Miniflare shutdown", () => {
    const result = runBunFixture(fixtureRoot, {
      env: {
        BUN_TEST_CLOUDFLARE_DEBUG_CLEANUP: "1",
      },
      fixtureTests: ["./browserRenderingLeakedSession.fixture.ts"],
      installMode: "full",
      testArgs: ["--parallel=1"],
      timeoutMs: 20_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).toContain("closing 1 Browser Rendering session(s)");
    expect(output).not.toContain("Not all browser processes were closed");
    expect(output).not.toContain("killed ");
    expect(output).not.toContain("timed out");
  }, 25_000);

  test("does not remove Browser Rendering profile directories while launches are in flight", () => {
    const result = runBunFixture(fixtureRoot, {
      installMode: "full",
      testArgs: ["--parallel=4", "--parallel-delay=0"],
      timeoutMs: 20_000,
    });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("Failed to launch the browser process");
    expect(output).not.toContain("SingletonLock");
    expect(output).not.toContain("ERR_RUNTIME_FAILURE");
    expect(output).not.toContain("Not all browser processes were closed");
    expect(output).not.toContain("timed out");
  }, 25_000);
});
