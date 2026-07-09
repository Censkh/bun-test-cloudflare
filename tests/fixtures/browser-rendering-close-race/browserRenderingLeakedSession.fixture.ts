import { expect, test } from "bun:test";
import { harness } from "./harness";

test("browser rendering leaked session", async () => {
  await harness.run(async (workers) => {
    const response = await workers.WORKER.fetch("https://browser-rendering-close-race.test/?leak=1");
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  });
});
