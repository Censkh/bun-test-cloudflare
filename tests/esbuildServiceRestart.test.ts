import { expect, test } from "bun:test";
import { createPatchedEsbuild } from "../src/patches/WranglerGuessWorkerFormatPatch";

const restartOnly = { cacheGuessWorkerFormat: false, restartStoppedService: true };

const createEsbuild = (failure: () => Error) => {
  const calls: string[] = [];
  let running = false;
  const esbuild = {
    build: async (options: { entryPoints?: string[] }) => {
      calls.push(`build:${running ? "running" : "dead"}`);
      if (!running) throw failure();
      return { entryPoints: options.entryPoints };
    },
    stop: () => {
      calls.push("stop");
      running = true;
    },
    version: "0.0.0",
  };
  return { calls, esbuild };
};

test("restarts a service that died, as when Bun kills it after a test timeout, and retries once", async () => {
  const { calls, esbuild } = createEsbuild(() => new Error("The service is no longer running: write EPIPE"));
  const patched = createPatchedEsbuild(esbuild, restartOnly);

  expect(await patched.build({ entryPoints: ["worker.ts"] })).toEqual({ entryPoints: ["worker.ts"] });
  expect(calls).toEqual(["build:dead", "stop", "build:running"]);
  expect(patched.version).toBe("0.0.0");
});

test("leaves other build failures alone", async () => {
  const buildError = new Error('Could not resolve "missing"');
  const { calls, esbuild } = createEsbuild(() => buildError);
  const patched = createPatchedEsbuild(esbuild, restartOnly);

  await expect(patched.build({ entryPoints: ["worker.ts"] })).rejects.toBe(buildError);
  expect(calls).toEqual(["build:dead"]);
});

test("does not wrap esbuild when the restart patch is disabled", async () => {
  const stopped = new Error("The service is no longer running");
  const { calls, esbuild } = createEsbuild(() => stopped);
  const patched = createPatchedEsbuild(esbuild, { cacheGuessWorkerFormat: false, restartStoppedService: false });

  await expect(patched.build({})).rejects.toBe(stopped);
  expect(calls).toEqual(["build:dead"]);
});

const probe = {
  absWorkingDir: "/worker",
  bundle: false,
  entryPoints: ["worker.js"],
  logLevel: "silent",
  metafile: true,
  write: false,
};

test("restarts the service once when several calls fail together, and every call succeeds", async () => {
  let stops = 0;
  const esbuild = {
    build: async () => {
      if (stops === 0) throw new Error("The service was stopped: Cannot call write after a stream was destroyed");
      if (stops > 1) throw new Error("the replacement service was stopped");
      return "built";
    },
    stop: () => {
      stops += 1;
    },
  };
  const patched = createPatchedEsbuild(esbuild, restartOnly);

  expect(await Promise.all([patched.build({}), patched.build({}), patched.build({})])).toEqual([
    "built",
    "built",
    "built",
  ]);
  expect(stops).toBe(1);
});

test("restarts a service that never answers a format probe", async () => {
  let rejectStalled!: (error: Error) => void;
  let stopped = false;
  const esbuild = {
    build: () =>
      stopped
        ? Promise.resolve("built")
        : new Promise((_, reject) => {
            rejectStalled = reject;
          }),
    stop: () => {
      stopped = true;
      rejectStalled(new Error("The service was stopped"));
    },
  };
  const patched = createPatchedEsbuild(esbuild, { ...restartOnly, stalledProbeTimeoutMs: 5 });

  expect(await patched.build(probe)).toBe("built");
  expect(stopped).toBe(true);
});

test("gives a real build as long as it needs", async () => {
  const { promise, resolve } = Promise.withResolvers<string>();
  let stops = 0;
  const esbuild = {
    build: () => promise,
    stop: () => {
      stops += 1;
    },
  };
  const patched = createPatchedEsbuild(esbuild, { ...restartOnly, stalledProbeTimeoutMs: 1 });

  const build = patched.build({ bundle: true, entryPoints: ["worker.ts"] });
  await Bun.sleep(20);
  resolve("built");

  expect(await build).toBe("built");
  expect(stops).toBe(0);
});

test("asks esbuild for a worker's format once, so a later session can't wait on the service", async () => {
  delete globalThis.__bunTestCloudflareGuessWorkerFormatBuildCache;
  let builds = 0;
  const esbuild = {
    build: async () => {
      builds += 1;
      return "format";
    },
  };
  const patched = createPatchedEsbuild(esbuild, { cacheGuessWorkerFormat: true, restartStoppedService: true });

  expect(await patched.build(probe)).toBe("format");
  expect(await patched.build(probe)).toBe("format");
  expect(await patched.build({ ...probe, entryPoints: ["other.js"] })).toBe("format");
  expect(builds).toBe(2);
});
