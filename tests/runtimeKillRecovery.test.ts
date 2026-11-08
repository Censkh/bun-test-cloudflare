import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "runtime-kill-recovery");
const fixture = bunFixtureTest(fixtureRoot);

describe("killed Workers runtime", () => {
  fixture.test(
    "fails only the run whose runtime died and recovers for later runs, including after a Bun timeout",
    ({ run }) => {
      const result = run({ testArgs: ["--max-concurrency=1"], timeoutMs: 15_000, processTimeoutMs: 120_000 });
      const output = `${result.stdout}\n${result.stderr}`;
      const failed = output.match(/^\(fail\) .*/gm) ?? [];
      const passed = Number(output.match(/^ (\d+) pass$/m)?.[1]);

      // Only the deliberately hung test fails; every run after it passes within its timeout.
      expect(failed.map((line) => line.replace(/ \[.*$/, ""))).toEqual(["(fail) BUN TIMEOUT"]);
      expect(passed).toBe(10);
      result.expectStatusCode(1);
    },
    150_000,
  );
});
