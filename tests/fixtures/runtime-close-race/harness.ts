import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

type Env = {
  OTHER: Fetcher;
};

export const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      bindings: typeToken<Env>(),
      configPath: path.join(import.meta.dir, "wrangler.worker.toml"),
      name: "runtime-close-race-worker",
    },
    OTHER: {
      configPath: path.join(import.meta.dir, "wrangler.other.toml"),
      name: "runtime-close-race-other",
    },
  },
});
