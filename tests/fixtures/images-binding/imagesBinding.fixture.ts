import { expect, test } from "bun:test";
import { Buffer } from "node:buffer";
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
    AUX_WORKER: {
      configPath: path.join(import.meta.dir, "wrangler-secondary.toml"),
      name: "images-binding-fixture-secondary",
    },
  },
});

const png1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABAQMAAAAl21bKAAAAAXNSR0IB2cksfwAAAAZQTFRFAAAApaPEY/fPxwAAAAJ0Uk5TAP9bkSK1AAAACklEQVR4nGNoAAAAggCBd81ytgAAAAA=",
  "base64",
);
const gif1x1 = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
const maxImageUploadBytes = 10 * 1024 * 1024;

const padOverUploadLimit = (bytes: Buffer) => Buffer.concat([bytes, Buffer.alloc(maxImageUploadBytes + 1)]);

const imageStream = (bytes: Buffer = png1x1) => {
  const stream = new Response(new Uint8Array(bytes)).body;
  if (!stream) throw new Error("failed to create image stream");
  return stream;
};

const streamToBytes = async (stream: ReadableStream<Uint8Array>) => {
  return Buffer.from(await new Response(stream).arrayBuffer());
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

const lossyFormats = new Set(["image/jpeg", "image/webp", "image/avif"]);

const getQualityCandidates = (mimeType: string) => {
  if (!lossyFormats.has(mimeType)) {
    return [undefined];
  }
  return [85, 75, 65, 55, 45];
};

const getScaledDimensions = (width: number, height: number, scale: number) => ({
  width: Math.max(1, Math.floor(width * scale)),
  height: Math.max(1, Math.floor(height * scale)),
});

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

const normalizeLikeBackend = async (env: ImagesEnv, bytes: Buffer, mimeType: string) => {
  const imageInfo = await env.IMAGES.info(imageStream(bytes));
  expect(imageInfo.width).toBe(1);

  const byteScale = Math.min(1, Math.sqrt(maxImageUploadBytes / bytes.byteLength) * 0.98);
  const scaleCandidates = [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2].map(
    (multiplier) => byteScale * multiplier,
  );

  for (const outputMimeType of getOutputCandidates(mimeType)) {
    for (const scale of scaleCandidates) {
      const { width, height } = getScaledDimensions(imageInfo.width, imageInfo.height, scale);
      for (const quality of getQualityCandidates(outputMimeType)) {
        try {
          const output = await env.IMAGES.input(imageStream(bytes))
            .transform({ width, height, fit: "scale-down" })
            .output({ format: outputMimeType, quality });
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

test("backend-like parallel oversized normalization reports unsupported HEIF errors", async () => {
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
      expect(failure.reason).toBeInstanceOf(Error);
      expect((failure.reason as Error).message).toContain("Unsupported image type heif, expected");
      return;
    }

    for (const result of results) {
      expect(result.status).toBe("fulfilled");
    }
  });
});
