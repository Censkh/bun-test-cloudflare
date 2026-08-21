import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "prewarmed-storage-reset");
const fixture = bunFixtureTest(fixtureRoot);

describe("prewarmed harness storage reset", () => {
  fixture.test(
    "resets D1, KV, and R2 before reusing a warmed Worker session",
    ({ run }) => {
      run({ timeoutMs: 30_000 }).expectStatusCode(0);
    },
    45_000,
  );
});
