import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "harness-variants"));

describe("harness variants", () => {
  fixture.test(
    "set vars and queue consumption for their runs, sharing their harness's runtime",
    ({ run }) => {
      const result = run({ testArgs: ["--preload", "./runCount.ts"], timeoutMs: 60_000 });
      result.expectStatusCode(0);
    },
    120_000,
  );
});
