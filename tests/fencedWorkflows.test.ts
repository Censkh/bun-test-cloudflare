import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "fenced-workflows"));

describe("Workflows in fenced Worker slots", () => {
  fixture.test(
    "run with their run's bindings, under the IDs it gave them, apart from other runs' instances",
    ({ run }) => {
      const result = run({ timeoutMs: 60_000 });
      result.expectStatusCode(0);
    },
    120_000,
  );
});
