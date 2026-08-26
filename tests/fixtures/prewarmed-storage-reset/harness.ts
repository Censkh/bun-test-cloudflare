import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export type StorageEnv = {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  KV: KVNamespace;
};

export const harness = createCloudflareHarness({
  isolatedWorkerSlots: Number(process.env.BUN_TEST_CLOUDFLARE_TEST_WORKER_SLOTS ?? 2),
  prewarmedWorkerdPoolSize: 2,
  workers: {
    WORKER: {
      bindings: typeToken<StorageEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "prewarmed-storage-reset",
    },
  },
});
