import { expect, test } from "bun:test";
import { harness } from "./workerHarness";

test("the shared build serves both Workers", async () => {
  await harness.run(async (workers) => {
    expect(await (await workers.BACKEND.fetch("https://example.com/")).text()).toBe("backend-ok");
    expect(await (await workers.CMS.fetch("https://example.com/")).json()).toEqual({ ok: true, source: "cms" });
  });
});
