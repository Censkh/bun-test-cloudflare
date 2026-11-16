import { beforeAll, expect, test } from "bun:test";
import { vars, varsHarness } from "./varsHarness";

beforeAll(() => {
  vars.GREETING = "file-b";
});

test("the Worker reads the value file B set after creating the harness", async () => {
  await varsHarness.run(async (workers) => {
    expect(await (await workers.VARS.fetch("https://example.com/")).text()).toBe("file-b");
  });
});
