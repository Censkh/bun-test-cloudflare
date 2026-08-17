import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "esbuild-service-cleanup");

const fixture = bunFixtureTest(fixtureRoot);

fixture.test("stops Wrangler esbuild services after harness teardown", ({ run }) => {
  const result = run({ timeoutMs: 20_000 });

  result.expectStatusCode(0);
});
