import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

type ImagesEnv = {
  IMAGES: ImagesBinding;
};

const harness = createCloudflareHarness({
  workers: {
    IMAGE_WORKER: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "images-binding-fixture",
    },
  },
});

const png1x1 = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  ),
);
const gif1x1 = Uint8Array.from(Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64"));
const maxImageUploadBytes = 10 * 1024 * 1024;

const padOverUploadLimit = (bytes: Uint8Array) => {
  const padded = new Uint8Array(bytes.length + maxImageUploadBytes + 1);
  padded.set(bytes);
  return padded;
};

const imageStream = (bytes = png1x1) => {
  const stream = new Response(bytes).body;
  if (!stream) throw new Error("failed to create image stream");
  return stream;
};

const streamToBytes = async (stream: ReadableStream<Uint8Array>) => {
  return new Uint8Array(await new Response(stream).arrayBuffer());
};

const imageFormats = [
  { mimeType: "image/png", outputFormat: "image/png" },
  { mimeType: "image/jpeg", outputFormat: "image/jpeg" },
  { mimeType: "image/webp", outputFormat: "image/webp" },
  { mimeType: "image/avif", outputFormat: "image/avif" },
  { mimeType: "image/gif", outputFormat: "image/gif" },
] as const;

const getOutputCandidates = (mimeType: string) => {
  switch (mimeType) {
    case "image/png":
      return ["image/png", "image/webp", "image/avif"] as const;
    case "image/gif":
      return ["image/gif", "image/webp"] as const;
    case "image/webp":
      return ["image/webp", "image/avif", "image/jpeg"] as const;
    case "image/avif":
      return ["image/avif", "image/webp", "image/jpeg"] as const;
    default:
      return ["image/jpeg", "image/webp", "image/avif"] as const;
  }
};

const prepareOversizedInput = async (env: ImagesEnv, format: (typeof imageFormats)[number]) => {
  if (format.mimeType === "image/png") {
    return padOverUploadLimit(png1x1);
  }
  if (format.mimeType === "image/gif") {
    return padOverUploadLimit(gif1x1);
  }

  const output = await env.IMAGES.input(imageStream()).output({
    format: format.outputFormat,
    quality: 100,
  });
  return padOverUploadLimit(await streamToBytes(output.image()));
};

const normalizeLikeBackend = async (env: ImagesEnv, bytes: Uint8Array, mimeType: string) => {
  const imageInfo = await env.IMAGES.info(imageStream(bytes));
  expect(imageInfo.width).toBe(1);

  for (const outputMimeType of getOutputCandidates(mimeType)) {
    try {
      const output = await env.IMAGES.input(imageStream(bytes))
        .transform({ width: 1, height: 1, fit: "scale-down" })
        .output({ format: outputMimeType });
      const outputBytes = await streamToBytes(output.image());
      if (outputBytes.byteLength <= maxImageUploadBytes) {
        return outputBytes;
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("GIF output is not supported in local mode")) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("No image output candidate worked");
};

test("uses Images binding from worker getEnv", async () => {
  await harness.run(async (workers) => {
    const env = await workers.IMAGE_WORKER.getEnv<ImagesEnv>();
    const info = await env.IMAGES.info(imageStream());
    expect(info.width).toBe(1);
    expect(info.height).toBe(1);
  });
});

test("transforms Images binding output from worker getEnv", async () => {
  await harness.run(async (workers) => {
    const env = await workers.IMAGE_WORKER.getEnv<ImagesEnv>();
    const output = await env.IMAGES.input(imageStream()).output({ format: "webp", width: 1, height: 1 });
    const bytes = await streamToBytes(output.image());
    const info = await env.IMAGES.info(new Response(bytes).body!);

    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(info.width).toBe(1);
    expect(info.height).toBe(1);
  });
});

test("backend-like parallel oversized normalization exposes stream teardown issue", async () => {
  await harness.run(async (workers) => {
    const env = await workers.IMAGE_WORKER.getEnv<ImagesEnv>();

    const results = await Promise.allSettled(
      imageFormats.map(async (format) => {
        const inputBytes = await prepareOversizedInput(env, format);
        expect(inputBytes.byteLength).toBeGreaterThan(maxImageUploadBytes);

        const normalizedBytes = await normalizeLikeBackend(env, inputBytes, format.mimeType);
        expect(normalizedBytes.byteLength).toBeLessThanOrEqual(maxImageUploadBytes);

        const inputInfo = await env.IMAGES.info(imageStream(inputBytes));
        const outputInfo = await env.IMAGES.info(imageStream(normalizedBytes));
        expect(inputInfo.width).toBe(1);
        expect(outputInfo.width).toBe(1);
      }),
    );

    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  });
});
