import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "cloudflare-harness");

const fixture = bunFixtureTest(fixtureRoot);

describe("Cloudflare harness fixture", () => {
  fixture.test(
    "passes in its own Bun test process",
    ({ run }) => {
      const result = run();
      result.expectStatusCode(0);
    },
    45_000,
  );
});
