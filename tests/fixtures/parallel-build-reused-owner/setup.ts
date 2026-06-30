import "bun-test-cloudflare/setup";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const originalSpawnSync = Bun.spawnSync;
const buildLogPath = path.join(import.meta.dir, "node_modules/.btcf/parallel-build-reused-owner/builds.log");

Bun.spawnSync = ((options: Parameters<typeof Bun.spawnSync>[0]) => {
  const command = "cmd" in options ? options.cmd.map(String) : [];
  const isWranglerDryRun = command.includes("deploy") && command.includes("--dry-run");
  if (!isWranglerDryRun) {
    return originalSpawnSync(options as any) as any;
  }

  const outdir = command[command.indexOf("--outdir") + 1];
  if (!outdir) {
    return { exitCode: 1, stdout: Buffer.from(""), stderr: Buffer.from("missing --outdir") } as any;
  }

  mkdirSync(path.dirname(buildLogPath), { recursive: true });
  appendFileSync(buildLogPath, `${process.pid}:${process.env.BUN_TEST_WORKER_ID ?? "main"}\n`);

  mkdirSync(outdir, { recursive: true });
  writeFileSync(path.join(outdir, "worker.js"), "export default { fetch() { return new Response('ok') } };\n");
  return { exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from("") } as any;
}) as typeof Bun.spawnSync;
