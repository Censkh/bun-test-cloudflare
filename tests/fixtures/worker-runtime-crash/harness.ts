import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  prewarmedWorkerdPoolSize: 2,
  workers: {
    WORKER: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "worker-runtime-crash",
    },
  },
});
