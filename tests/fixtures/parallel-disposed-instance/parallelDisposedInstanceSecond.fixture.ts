import { expect, test } from "bun:test";
import { harness, imageStream } from "./harness";

test("second file uses Images binding", async () => {
  await harness.run(async (workers) => {
    const env = await workers.IMAGE_WORKER.getEnv();
    const info = await env.IMAGES.info(imageStream());
    expect(info.width).toBe(1);
  });
});
