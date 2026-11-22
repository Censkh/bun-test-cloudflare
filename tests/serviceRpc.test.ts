import { describe } from "bun:test";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "service-rpc"));

describe("service binding RPC in fenced Worker slots", () => {
  fixture.test(
    "reaches the target Worker's entrypoint from a Worker and from its Durable Objects",
    ({ run }) => {
      const result = run({ timeoutMs: 60_000 });
      result.expectStatusCode(0);
      run({ env: { BUN_TEST_CLOUDFLARE_SHARED_SLOTS: "2" }, timeoutMs: 60_000 }).expectStatusCode(0);
    },
    120_000,
  );
});
