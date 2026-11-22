import { describe } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixtureRoot = fixturePath(import.meta.dir, "large-modules");
const fixture = bunFixtureTest(fixtureRoot);
// Larger than the 32 MiB an RPC value can hold (and under workerd's 64 MiB for a dynamic Worker's
// code), marked at both ends.
const LARGE_MODULE_BYTES = 33 * 1024 * 1024;

describe("large Worker modules", () => {
  fixture.test(
    "load into fenced Worker slots whole",
    ({ run }) => {
      writeFileSync(
        path.join(fixtureRoot, "src/large.ts"),
        `export default ${JSON.stringify(`<${"x".repeat(LARGE_MODULE_BYTES - 2)}>`)};\n`,
      );
      const result = run({ env: { LARGE_MODULE_BYTES: String(LARGE_MODULE_BYTES) }, timeoutMs: 60_000 });
      result.expectStatusCode(0);
    },
    120_000,
  );
});
