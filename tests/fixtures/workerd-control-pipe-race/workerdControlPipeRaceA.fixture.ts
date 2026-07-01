import { test } from "bun:test";
import { runRawHarness } from "./rawHarness";

for (let index = 0; index < 8; index++) {
  test("raw workerd control pipe race A " + index, async () => {
    await runRawHarness("A-" + index);
  });
}
