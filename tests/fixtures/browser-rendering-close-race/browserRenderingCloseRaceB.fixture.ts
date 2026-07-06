import { expect, test } from "bun:test";
import { harness } from "./harness";

for (let index = 0; index < 8; index++) {
  test(`browser rendering close race B ${index}`, async () => {
    await harness.run(async (workers) => {
      const response = await workers.WORKER.fetch("https://browser-rendering-close-race.test/");
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    });
  });
}
