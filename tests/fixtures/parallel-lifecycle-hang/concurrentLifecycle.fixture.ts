import { expect, test } from "bun:test";
import { harness } from "./harness";

test("overlapping harness runs do not poison Wrangler startup", async () => {
  const runOne = async (index: number) => {
    await harness.run(async (workers) => {
      const formData = new FormData();
      formData.set("value", "concurrent-" + index);
      const response = await workers.BACKEND.fetch("https://backend.local/multipart?id=concurrent-" + index, {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ value: "concurrent-" + index });
    });
  };

  await Promise.all(Array.from({ length: 4 }, (_, index) => runOne(index)));
});
