import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closePrewarmedServerOrchestrators, createCloudflareHarness } from "bun-test-cloudflare";

test("a custom build can create a later Worker's configuration", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "btcf-custom-build-"));
  writeFileSync(path.join(root, "worker.ts"), 'export default { fetch: () => new Response("ok") };');
  const secondConfig = 'name = "second"\nmain = "worker.ts"\ncompatibility_date = "2025-08-15"\n';
  writeFileSync(
    path.join(root, "generate.ts"),
    `import { writeFileSync } from "node:fs";
writeFileSync("second.toml", ${JSON.stringify(secondConfig)});`,
  );
  try {
    const harness = createCloudflareHarness({
      root,
      workers: {
        FIRST: {
          config: {
            name: "first",
            main: "worker.ts",
            compatibility_date: "2025-08-15",
            build: { command: "bun generate.ts", cwd: root },
          },
        },
        SECOND: { configPath: path.join(root, "second.toml") },
      },
    });
    await harness.run(async (workers) => {
      expect(await (await workers.FIRST.fetch("https://example.com")).text()).toBe("ok");
      expect(await (await workers.SECOND.fetch("https://example.com")).text()).toBe("ok");
    });
  } finally {
    await closePrewarmedServerOrchestrators();
    rmSync(root, { force: true, recursive: true });
  }
});
