import { expect, test } from "bun:test";
import { harness } from "./harness";

const sleep = (durationMs: number) => new Promise((resolve) => setTimeout(resolve, durationMs));
const fileDelay = 1 * 0;
const staggerDelays: Record<string, number> = {
  A: 0,
  B: 700,
  C: 50,
  D: 1100,
  E: 100,
  F: 1500,
  G: 150,
  H: 1900,
  I: 200,
  J: 2300,
  K: 250,
  L: 2700,
};

for (let index = 0; index < 2; index++) {
  test(`parallel lifecycle C ${index}`, async () => {
    await harness.run(async (workers) => {
      const formData = new FormData();
      formData.set("value", `C-${index}`);

      const createResponse = await workers.BACKEND.fetch(`https://backend.local/multipart?id=C-${index}`, {
        method: "POST",
        body: formData,
      });
      expect(createResponse.status).toBe(200);
      expect(await createResponse.json()).toMatchObject({ value: `C-${index}` });

      if (index % 3 === 0) {
        const imageResponse = await workers.BACKEND.fetch("https://backend.local/image-info");
        expect(await imageResponse.json()).toMatchObject({ width: 1, height: 1 });
      }

      if (index % 2 === 0) {
        const cdnResponse = await workers.BACKEND.fetch(`https://backend.local/cdn?id=C-${index}`);
        expect(await cdnResponse.json()).toMatchObject({ ok: true });
      }

      if (index === 0) {
        await sleep(staggerDelays.C ?? fileDelay);
      }
    });
  });
}
