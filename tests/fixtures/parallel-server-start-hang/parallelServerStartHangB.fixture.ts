import { expect, test } from "bun:test";
import { createClient } from "./client";
import { harness } from "./harness";

const minMultipartPartBytes = 5 * 1024 * 1024;

const runMultipartFlow = async () => {
  const firstPart = Buffer.alloc(minMultipartPartBytes, 1);
  const finalPart = Buffer.from([2, 3, 4]);
  const client = createClient();
  await expect(client.assets.multipartComplete(firstPart, finalPart)).resolves.toMatchObject({
    bytes: minMultipartPartBytes + finalPart.length,
    receivedParts: 2,
  });
};

for (let index = 0; index < 12; index++) {
  test("parallel server start B " + index, async () => {
    await harness.run(async (workers) => {
      const env = await workers.BACKEND.getEnv();
      await env.DB.prepare("INSERT INTO items (id, value) VALUES (?, ?)")
        .bind("B-env-" + index, "env")
        .run();

      const client = createClient();
      if (index % 4 === 0) {
        await expect(client.assets.create({ name: "invalid" })).rejects.toThrow();
      } else if (index % 4 === 1) {
        await expect(client.assets.create({ content: { base64: "abc", type: "image/png" } })).rejects.toThrow();
      } else {
        const asset = await client.assets.create({
          name: "asset-B-" + index,
          metadata: [
            { name: "score", type: "number", value: "0.98" },
            { name: "published", type: "boolean", value: "true" },
            { name: "sourceUrl", type: "url", value: "https://example.com/image.png" },
          ],
          content: {
            base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            type: "image/png",
          },
        });
        expect(asset.metadata).toMatchObject({ score: 0.98, published: true });
      }

      const infoResponse = await workers.BACKEND.fetch("https://example.com/image-info");
      expect(await infoResponse.json()).toMatchObject({ width: 1, height: 1 });

      const serviceResponse = await workers.BACKEND.fetch("https://example.com/other");
      expect(await serviceResponse.json()).toEqual({ other: true });

      if (index >= 9) {
        await runMultipartFlow();
      }
    });
  });
}
