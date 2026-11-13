import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "scoped-harness-pools"));

describe("harness pool lifetime", () => {
  fixture.test(
    "stops a harness's workerd when the test, block or file that created it ends",
    ({ run }) => {
      const result = run({ testArgs: ["--max-concurrency=1"], processTimeoutMs: 120_000 });
      const output = `${result.stdout}\n${result.stderr}`;
      expect(output.match(/^\(fail\) .*/gm) ?? []).toEqual([]);
      expect(Number(output.match(/^ (\d+) pass$/m)?.[1])).toBe(8);
      result.expectStatusCode(0);
    },
    150_000,
  );
});
