import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

if (path.basename(process.argv[1] ?? "") === "wrangler.js") {
  const configPath = process.argv[process.argv.indexOf("--config") + 1]!;
  const name = path.basename(path.dirname(configPath)).startsWith("backend-fixture-") ? "backend" : "cms";
  const other = name === "backend" ? "cms" : "backend";
  const barrier = process.env.BTCF_BUILD_BARRIER_DIR!;
  mkdirSync(barrier, { recursive: true });
  appendFileSync(path.join(barrier, name), "started\n");
  const deadline = Date.now() + 15_000;
  while (!existsSync(path.join(barrier, other))) {
    if (Date.now() >= deadline) throw new Error("Worker builds did not overlap");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  if (process.env.BTCF_BUILD_BARRIER_FAIL === name) throw new Error("intentional build failure");
}
