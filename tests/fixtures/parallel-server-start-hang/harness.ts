import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

type BackendEnv = {
  DB: D1Database;
  OTHER: Fetcher;
};

const syncSchema = async (env: BackendEnv) => {
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS items (id TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
};

export const harness = createCloudflareHarness({
  events: {
    beforeRun: async (workers) => {
      await syncSchema(await workers.BACKEND.getEnv());
    },
  },
  workers: {
    BACKEND: {
      bindings: typeToken<BackendEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.backend.toml"),
      name: "parallel-server-start-hang-backend",
    },
    OTHER: {
      configPath: path.join(import.meta.dir, "wrangler.other.toml"),
      name: "parallel-server-start-hang-other",
    },
  },
});
