import { expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

type BackendEnv = {
  CMS: Fetcher;
};

const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
      bindings: typeToken<BackendEnv>(),
      configPath: path.join(import.meta.dir, "wrangler.backend.toml"),
      name: "missing-module-backend",
    },
    CMS: {
      configPath: path.join(import.meta.dir, "wrangler.cms.toml"),
      name: "missing-module-cms",
    },
  },
});

test("service binding handles Worker runtime module resolution", async () => {
  await harness.run(async (workers) => {
    const response = await workers.BACKEND.fetch("https://backend.local/");
    const body = await response.text();
    console.error(body);
    expect(response.status).toBe(200);
    expect(body).toBe("loaded");
  });
});
