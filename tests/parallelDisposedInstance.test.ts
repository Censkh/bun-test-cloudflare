import { describe, expect, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-disposed-instance");

describe("parallel worker build lock", () => {
  test("serializes shared worker builds across parallel Bun workers", () => {
    const result = runBunFixture(fixtureRoot, { testArgs: ["--parallel=2"], timeoutMs: 15_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("JSON Parse error: Unexpected EOF");
    expect(output).not.toContain("Cannot use disposed instance");
  });
});
