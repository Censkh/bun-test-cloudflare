import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  workers: {
    WORKER: {
      bindings: typeToken<{ DB: D1Database; KV: KVNamespace }>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "shared-slot-broker",
    },
  },
});
