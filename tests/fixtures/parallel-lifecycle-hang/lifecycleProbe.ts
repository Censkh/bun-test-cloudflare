import { mock } from "bun:test";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const wrangler = require("wrangler") as typeof import("wrangler");
const originalCreateTestHarness = wrangler.createTestHarness;
const lifecycleProbeDir = path.join(import.meta.dir, "node_modules/.btcf/lifecycle-probe");

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error;

const lockPath = (filename: string) => path.join(lifecycleProbeDir, filename);

const acquireProbeLock = (filename: string, operation: string) => {
  mkdirSync(lifecycleProbeDir, { recursive: true });
  const path = lockPath(filename);
  const lockFile = openSync(path, "wx");
  writeFileSync(lockFile, `${process.pid}:${operation}`);
  return () => {
    closeSync(lockFile);
    unlinkSync(path);
  };
};

const activeCloseCount = () => {
  mkdirSync(lifecycleProbeDir, { recursive: true });
  return readdirSync(lifecycleProbeDir).filter((filename) => filename.startsWith("close-")).length;
};

const runLifecycleOperation = async <TResult>(operation: "close" | "listen", callback: () => Promise<TResult>) => {
  let release: (() => void) | undefined;
  try {
    if (operation === "listen") {
      release = acquireProbeLock("listen.lock", operation);
      if (activeCloseCount() > 0) {
        throw new Error("Overlapping Wrangler harness lifecycle: listen started while close was active");
      }
    } else {
      release = acquireProbeLock(`close-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`, operation);
      if (existsSync(lockPath("listen.lock"))) {
        throw new Error("Overlapping Wrangler harness lifecycle: close started while listen was active");
      }
    }
  } catch (error) {
    if (isErrnoException(error) && error.code === "EEXIST") {
      throw new Error(`Overlapping Wrangler harness lifecycle: ${operation} started while another process was active`);
    }
    throw error;
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return await callback();
  } finally {
    if (release) {
      try {
        release();
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
};

mock.module("wrangler", () => ({
  ...wrangler,
  createTestHarness: (...args: Parameters<typeof originalCreateTestHarness>) => {
    const server = originalCreateTestHarness(...args);
    const originalListen = server.listen.bind(server);
    const originalClose = server.close.bind(server);

    server.listen = (...listenArgs: Parameters<typeof server.listen>) =>
      runLifecycleOperation("listen", () => originalListen(...listenArgs));
    server.close = (...closeArgs: Parameters<typeof server.close>) =>
      runLifecycleOperation("close", () => originalClose(...closeArgs));

    return server;
  },
}));
