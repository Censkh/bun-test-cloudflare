import { afterAll, expect, test } from "bun:test";
import path from "node:path";
import { closePrewarmedServerOrchestrators, createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    FIRST: {
      configPath: path.join(import.meta.dir, "wrangler.first.toml"),
      name: "esbuild-service-cleanup-first",
    },
    SECOND: {
      configPath: path.join(import.meta.dir, "wrangler.second.toml"),
      name: "esbuild-service-cleanup-second",
    },
  },
});

const getEsbuildServiceProcesses = () => {
  const result = Bun.spawnSync({ cmd: ["ps", "-axo", "pid=,ppid=,command="] });
  const parentProcessId = String(process.pid);

  return result.stdout
    .toString()
    .split("\n")
    .filter((line) => {
      const [processId, parentProcessIdFromPs, ...command] = line.trim().split(/\s+/);
      return (
        processId !== undefined &&
        parentProcessIdFromPs === parentProcessId &&
        command.join(" ").includes("esbuild --service")
      );
    });
};

test("runs a multi-worker harness", async () => {
  await harness.run(async (workers) => {
    expect(await (await workers.FIRST.fetch("https://example.com/")).text()).toBe("first");
    expect(await (await workers.SECOND.fetch("https://example.com/")).text()).toBe("second");
  });
});

afterAll(async () => {
  await closePrewarmedServerOrchestrators();
  await Bun.sleep(100);
  expect(getEsbuildServiceProcesses()).toEqual([]);
});
