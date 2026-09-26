// Launched by harnessServe.fixture.ts as its own `bun test` process
import path from "node:path";
import { createCloudflareHarness, serveHarnessUntilExit } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "harness-serve-fixture",
    },
  },
});

serveHarnessUntilExit(harness, {
  worker: "BACKEND",
  port: Number(process.env.SERVE_UNTIL_EXIT_PORT ?? 0),
  onReady: async (server) => {
    const env = await server.workers.BACKEND.getEnv();
    await env.KV.put("ready", "yes");
  },
});
