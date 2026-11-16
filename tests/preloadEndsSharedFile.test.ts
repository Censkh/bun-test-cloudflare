import { expect, test } from "bun:test";
import { preloadEndsSharedFile } from "../src/PrewarmedServerOrchestrator";

test("the setup preload ends a file another can follow in only in a --parallel --no-isolate worker", () => {
  expect(preloadEndsSharedFile("/usr/local/bin/bun test --test-worker --no-isolate --timeout=5000")).toBe(true);
  // A worker running isolated files.
  expect(preloadEndsSharedFile("/usr/local/bin/bun test --test-worker --timeout=5000")).toBe(false);
  // In-process runs, where it ends the run.
  expect(preloadEndsSharedFile("bun test a.test.ts b.test.ts")).toBe(false);
  expect(preloadEndsSharedFile("bun test --parallel=1 --no-isolate a.test.ts b.test.ts")).toBe(false);
  expect(preloadEndsSharedFile("bun test --isolate a.test.ts")).toBe(false);
});

test("a command line that can't be read keeps nothing", () => {
  expect(preloadEndsSharedFile(null)).toBe(false);
});
