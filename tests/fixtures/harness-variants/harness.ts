import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  prewarmedWorkerdPoolSize: 1,
  workers: {
    WORKER: {
      bindings: typeToken<{ GREETING: string; KV: KVNamespace }>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "harness-variants",
    },
  },
});
