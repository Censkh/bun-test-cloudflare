import "bun-test-cloudflare/setup";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

const originalSpawnSync = Bun.spawnSync;
const buildLogPath = path.join(import.meta.dir, "node_modules/.btcf/parallel-build-failure/builds.log");

Bun.spawnSync = ((options: Parameters<typeof Bun.spawnSync>[0]) => {
  const command = "cmd" in options ? options.cmd.map(String) : [];
  const isWranglerDryRun = command.includes("deploy") && command.includes("--dry-run");
  if (!isWranglerDryRun) {
    return originalSpawnSync(options as any) as any;
  }

  mkdirSync(path.dirname(buildLogPath), { recursive: true });
  appendFileSync(buildLogPath, `${process.pid}:${process.env.BUN_TEST_WORKER_ID ?? "main"}\n`);
  return {
    exitCode: 1,
    stdout: Buffer.from("fixture build stdout"),
    stderr: Buffer.from("fixture build failed intentionally"),
  } as any;
}) as typeof Bun.spawnSync;
