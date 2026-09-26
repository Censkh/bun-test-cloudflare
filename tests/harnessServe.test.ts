import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "harness-serve");

const fixture = bunFixtureTest(fixtureRoot);

describe("harness.serve fixture", () => {
  fixture.test(
    "passes in its own Bun test process",
    ({ run }) => {
      const result = run();
      result.expectStatusCode(0);
    },
    180_000,
  );
});
