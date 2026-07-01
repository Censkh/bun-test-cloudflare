import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

type Env = {
  BROWSER: Fetcher;
};

export const harness = createCloudflareHarness({
  workers: {
    WORKER: {
      bindings: typeToken<Env>(),
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "browser-rendering-close-race-worker",
    },
  },
});
