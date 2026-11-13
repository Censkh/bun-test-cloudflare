import { expect, test } from "bun:test";
import { expectWorking, sharedHarness } from "./harness";
import { settledWorkerdCount } from "./workerdProcesses";

test("the shared harness's workerd stopped when the file that created it ended", async () => {
  expect(await settledWorkerdCount()).toBe(0);
});

test("the shared harness starts a new pool for a later file", () => expectWorking(sharedHarness));
