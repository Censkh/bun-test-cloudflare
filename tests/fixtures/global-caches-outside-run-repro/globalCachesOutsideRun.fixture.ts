import { expect, test } from "bun:test";
import { probeGlobalCaches } from "./globalCachesProbe";

test("module probing global caches outside harness.run should not crash", () => {
  expect(probeGlobalCaches()).toBeDefined();
});
