import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "harness-variants"));

describe("harness variants", () => {
  fixture.test(
    "set vars and queue consumption for their runs, sharing their harness's runtime",
    ({ run }) => {
      const result = run({
        fixtureTests: ["./variants.fixture.ts"],
        testArgs: ["--preload", "./runCount.ts"],
        timeoutMs: 60_000,
      });
      result.expectStatusCode(0);
    },
    120_000,
  );
  fixture.test("keeps overlapping shared-broker variants isolated", ({ run }) => {
    run({
      env: { BUN_TEST_CLOUDFLARE_SHARED_SLOTS: "2" },
      fixtureTests: ["./brokerVariants.fixture.ts"],
      timeoutMs: 60_000,
    }).expectStatusCode(0);
  });
});
