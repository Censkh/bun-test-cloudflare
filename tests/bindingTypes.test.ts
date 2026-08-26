import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "binding-types");
const fixture = bunFixtureTest(fixtureRoot);

describe("Cloudflare binding types", () => {
  fixture.test(
    "exercises locally simulated bindings through the harness",
    ({ run }) => {
      const result = run({ timeoutMs: 20_000 });
      result.expectStatusCode(0);
    },
    45_000,
  );
});
