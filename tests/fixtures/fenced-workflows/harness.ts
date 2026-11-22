import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  workers: {
    WORKER: {
      bindings: typeToken<{ KV: KVNamespace; RECORD: Workflow }>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "fenced-workflows",
    },
  },
});
