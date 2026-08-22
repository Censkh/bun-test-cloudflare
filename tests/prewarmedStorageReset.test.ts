import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "prewarmed-storage-reset");
const fixture = bunFixtureTest(fixtureRoot);

describe("prewarmed harness storage reset", () => {
  fixture.test(
    "resets D1, KV, and R2 before reusing a warmed Worker session",
    ({ run }) => {
      run({
        env: {
          BUN_TEST_CLOUDFLARE_TIMINGS: "1",
          BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS: "60000",
        },
        timeoutMs: 60_000,
      }).expectStatusCode(0);
    },
    75_000,
  );
});
