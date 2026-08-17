import { describe, expect } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "parallel-disposed-instance");

const fixture = bunFixtureTest(fixtureRoot);

describe("parallel worker build lock", () => {
  fixture.test("serializes shared worker builds across parallel Bun workers", ({ run }) => {
    const result = run({ testArgs: ["--parallel=2"], timeoutMs: 15_000 });
    const output = `${result.stdout}\n${result.stderr}`;

    result.expectStatusCode(0);
    expect(output).not.toContain("JSON Parse error: Unexpected EOF");
    expect(output).not.toContain("Cannot use disposed instance");
  });
});
