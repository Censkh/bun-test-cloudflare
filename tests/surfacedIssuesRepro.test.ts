import { describe, test } from "bun:test";
import { fixturePath, runBunFixture } from "./fixtureRunner";

describe("surfaced issue repro fixtures", () => {
  test("global caches access outside harness.run does not fail during module evaluation", () => {
    const result = runBunFixture(fixturePath(import.meta.dir, "global-caches-outside-run-repro"), {
      timeoutMs: 15_000,
    });

    result.expectStatusCode(0);
  });

  test("runtime dynamic imports are available from built Worker modules through service bindings", () => {
    const result = runBunFixture(fixturePath(import.meta.dir, "service-binding-missing-module-repro"), {
      installMode: "full",
      timeoutMs: 20_000,
    });

    result.expectStatusCode(0);
  }, 30_000);

  test("shared prewarmed harness remains usable across fixture files", () => {
    const result = runBunFixture(fixturePath(import.meta.dir, "shared-harness-closed-repro"), {
      testArgs: ["--max-concurrency=1"],
      timeoutMs: 20_000,
    });

    result.expectStatusCode(0);
  }, 30_000);
});
