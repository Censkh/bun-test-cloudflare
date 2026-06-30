import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "parallel-build-reused-owner-fixture",
    },
  },
});
