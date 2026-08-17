import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const fixtureRoot = import.meta.dir;
const generatedWorkerPath = path.join(fixtureRoot, ".open-next/worker.js");

if (!existsSync(generatedWorkerPath)) {
  const build = Bun.spawnSync({
    cmd: [process.execPath, "run", "build:opennext"],
    cwd: fixtureRoot,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (build.exitCode !== 0) {
    throw new Error(`OpenNext fixture build failed with exit code ${build.exitCode}`);
  }
}

const harness = createCloudflareHarness({
  workers: {
    APP: {
      configPath: path.join(fixtureRoot, "wrangler.toml"),
      name: "opennext-rendering-fixture",
    },
  },
});

const expectHtml = async (response: Response, expectedText: string) => {
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  expect(body).toContain(expectedText);
};

test("renders a Next page through the generated OpenNext worker", async () => {
  await harness.run(async (workers) => {
    const response = await workers.APP.fetch("https://example.test/");
    await expectHtml(response, "OpenNext rendered successfully");

    const cachedResponse = await workers.APP.fetch("https://example.test/cached");
    await expectHtml(cachedResponse, "OpenNext Cache Components rendered successfully");
  });
}, 120_000);
