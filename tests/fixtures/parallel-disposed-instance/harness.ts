import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export type ImagesEnv = {
  IMAGES: ImagesBinding;
};

export const harness = createCloudflareHarness({
  workers: {
    IMAGE_WORKER: {
      bindings: typeToken<ImagesEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "parallel-disposed-instance-fixture",
    },
  },
});

const png1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);

export const imageStream = () => {
  const stream = new Response(png1x1).body;
  if (!stream) throw new Error("failed to create image stream");
  return stream;
};
