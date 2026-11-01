import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

export const harness = createCloudflareHarness({
  workers: {
    BACKEND: { configPath: path.join(import.meta.dir, "wrangler.backend.toml"), name: "backend-fixture" },
    CMS: { configPath: path.join(import.meta.dir, "wrangler.cms.toml"), name: "cms-fixture" },
  },
});
