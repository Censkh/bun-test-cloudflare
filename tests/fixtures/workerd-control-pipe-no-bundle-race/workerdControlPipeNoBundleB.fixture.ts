import { test } from "bun:test";
import { runRawNoBundleHarness } from "./rawNoBundleHarness";

for (let index = 0; index < 10; index++) {
  test("raw no-bundle workerd control pipe race B " + index, async () => {
    await runRawNoBundleHarness("B-" + index);
  });
}
