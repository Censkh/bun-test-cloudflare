import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "wrangler-start-timeout-repro");
const fixtureTimeoutMs = 20_000;
const testTimeoutMs = 30_000;

const fixture = bunFixtureTest(fixtureRoot);

fixture.test(
  "Wrangler can restart after an abandoned harness run",
  ({ run }) => {
    const result = run({ testArgs: ["--no-orphans", "--max-concurrency=1"], timeoutMs: fixtureTimeoutMs });

    result.expectStatusCode(0);
  },
  testTimeoutMs,
);
