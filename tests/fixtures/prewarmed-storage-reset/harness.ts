import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export type StorageEnv = {
  DB: D1Database;
  DOCUMENTS: R2Bucket;
  KV: KVNamespace;
};

export const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      bindings: typeToken<StorageEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "prewarmed-storage-reset",
    },
  },
});
