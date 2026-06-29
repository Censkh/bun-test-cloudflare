import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FakeWorker = {
  name?: string;
  getEnv: <TEnv = Record<string, any>>() => Promise<TEnv>;
};

type FakeServer = {
  closeCalls: number;
  getWorkerCalls: string[];
  getLogsError?: unknown;
  listenCalls: number;
  close: () => Promise<void>;
  getLogs: () => unknown[];
  getWorker: (name?: string) => FakeWorker;
  listen: () => Promise<{ url: URL }>;
  logs: unknown[];
  workerEnvs: Record<string, unknown>;
};

const createdServers: FakeServer[] = [];
const lifecycleEvents: string[] = [];
let lastOptions: unknown;
const spawnedCommands: string[][] = [];
const testRoot = await mkdtemp(path.join(os.tmpdir(), "bun-test-cloudflare-harness-"));
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

const wranglerMock = {
  createTestHarness: (options: unknown) => {
    lastOptions = options;
    const server = createFakeServer();
    createdServers.push(server);
    return server;
  },
  unstable_readConfig: ({ config }: { config: string }) => ({
    compatibility_date: "2025-08-15",
    define: {
      "process.env.NODE_ENV": "'production'",
    },
    main: config.includes("cms") ? "src/cms.ts" : "src/backend.ts",
    name: config.includes("cms") ? "cms-worker" : "backend-worker",
    rules: [],
    triggers: {},
  }),
};

const createFakeServer = (): FakeServer => ({
  closeCalls: 0,
  getWorkerCalls: [],
  listenCalls: 0,
  async close() {
    lifecycleEvents.push("closed");
    this.closeCalls += 1;
  },
  getLogs() {
    if (this.getLogsError) {
      throw this.getLogsError;
    }
    return this.logs;
  },
  getWorker(name?: string) {
    this.getWorkerCalls.push(String(name));
    const worker: Partial<FakeWorker> = { name };
    Object.defineProperty(worker, "getEnv", {
      value: async () => this.workerEnvs[String(name)] ?? {},
    });
    return worker as FakeWorker;
  },
  async listen() {
    this.listenCalls += 1;
    return { url: new URL("http://127.0.0.1:8787") };
  },
  logs: [],
  workerEnvs: {},
});

mock.module("wrangler", () => wranglerMock);

const runFakeWranglerBuild = (command: string[]) => {
  spawnedCommands.push(command);
  const outdir = command[command.indexOf("--outdir") + 1];
  const configPath = command[command.indexOf("--config") + 1];
  const builtFile = configPath.includes("cms") ? "cms.js" : "backend.js";

  mkdirSync(outdir, { recursive: true });
  writeFileSync(path.join(outdir, builtFile), "export default {};");
};

Bun.spawnSync = ((options: { cmd: string[] }) => {
  runFakeWranglerBuild(options.cmd);
  return {
    exitCode: 0,
    stderr: Buffer.from(""),
    stdout: Buffer.from(""),
  };
}) as typeof Bun.spawnSync;

Bun.spawn = ((command: string[]) => {
  runFakeWranglerBuild(command);
  return {
    exited: (async () => {
      return 0;
    })(),
    stderr: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
    stdout: new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
  };
}) as typeof Bun.spawn;

afterAll(() => {
  Bun.spawn = originalSpawn;
  Bun.spawnSync = originalSpawnSync;
});

const { createCloudflareHarness, getCloudflareHarnessRunContext, typeToken } = await import("bun-test-cloudflare");

type Equal<TActual, TExpected> =
  (<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

test("passes worker configs to Wrangler while preserving typed worker keys", async () => {
  const harness = createCloudflareHarness({
    root: testRoot,
    workers: {
      BACKEND: {
        bindings: typeToken<{ IMAGES_BUCKET: { put: (key: string, value: Uint8Array) => Promise<void> } }>(),
        configPath: "./wrangler.backend.toml",
        name: "backend-worker",
      },
      CMS: { configPath: "./wrangler.cms.toml", vars: { APP_ENV: "test" } },
    },
  });

  let workers!: Parameters<Parameters<typeof harness.run>[0]>[0];
  await harness.run((runWorkers) => {
    workers = runWorkers;
  });

  expect(lastOptions).toEqual({
    root: testRoot,
    workers: [
      {
        config: expect.objectContaining({
          define: {
            "process.env.NODE_ENV": "'test'",
          },
          find_additional_modules: true,
          main: path.join(testRoot, "node_modules/.btcf/worker-build/backend-worker/worker.js"),
          no_bundle: true,
          rules: [{ type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] }],
        }),
      },
      {
        config: expect.objectContaining({
          define: {
            "process.env.NODE_ENV": "'test'",
          },
          find_additional_modules: true,
          main: path.join(testRoot, "node_modules/.btcf/worker-build/cms-worker/worker.js"),
          no_bundle: true,
          rules: [{ type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] }],
        }),
        vars: { APP_ENV: "test" },
      },
    ],
  });
  const configPaths = spawnedCommands.slice(-2).map((command) => command[command.indexOf("--config") + 1]);
  expect(configPaths.toSorted()).toEqual([
    path.join(testRoot, "node_modules/.btcf/worker-build/backend-worker/wrangler.json"),
    path.join(testRoot, "node_modules/.btcf/worker-build/cms-worker/wrangler.json"),
  ]);

  expect(workers.BACKEND as unknown).toEqual({ name: "backend-worker" });
  expect(workers.CMS as unknown).toEqual({ name: "CMS" });

  type BackendEnv = Awaited<ReturnType<(typeof workers)["BACKEND"]["getEnv"]>>;
  type _BackendEnvMatches = Expect<
    Equal<BackendEnv, { IMAGES_BUCKET: { put: (key: string, value: Uint8Array) => Promise<void> } }>
  >;
});

test("prebuilds inline worker configs with the same test transform", async () => {
  const harness = createCloudflareHarness({
    root: testRoot,
    workers: {
      BACKEND: {
        config: {
          compatibility_date: "2025-08-15",
          define: {
            "process.env.NODE_ENV": "'production'",
          },
          main: "src/backend.ts",
          name: "inline-backend",
        },
        name: "inline-backend",
      },
    },
  });

  await harness.run(() => {});

  expect(lastOptions).toEqual({
    root: testRoot,
    workers: [
      {
        config: expect.objectContaining({
          define: {
            "process.env.NODE_ENV": "'test'",
          },
          find_additional_modules: true,
          main: path.join(testRoot, "node_modules/.btcf/worker-build/inline-backend/worker.js"),
          no_bundle: true,
          rules: [{ type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] }],
        }),
      },
    ],
  });
  expect(spawnedCommands.at(-1)).toEqual(expect.arrayContaining(["deploy", "--dry-run", "--config"]));
  expect(spawnedCommands.at(-1)).toContain(
    path.join(testRoot, "node_modules/.btcf/worker-build/inline-backend/wrangler.json"),
  );
});

test("run starts the server, passes typed workers, and closes after success", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
      CMS: { configPath: "./wrangler.cms.toml", name: "cms-worker" },
    },
  });

  const result = await harness.run((workers, currentServer) => {
    const server = createdServers.at(-1)!;
    expect(currentServer as unknown).toBe(server);
    expect(workers.BACKEND as unknown).toEqual({ name: "backend-worker" });
    expect(workers.CMS as unknown).toEqual({ name: "cms-worker" });
    return "ok";
  });

  expect(result).toBe("ok");
  const server = createdServers.at(-1)!;
  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
});

test("run exposes workers and server through async run context", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });

  await harness.run(async (workers) => {
    const server = createdServers.at(-1)!;
    const context = getCloudflareHarnessRunContext<{
      BACKEND: { configPath: string; name: string };
    }>();

    expect(context.server as unknown).toBe(server);
    expect(context.workers.BACKEND as unknown).toEqual(workers.BACKEND as unknown);

    await Promise.resolve();

    const asyncContext = getCloudflareHarnessRunContext<{
      BACKEND: { configPath: string; name: string };
    }>();
    expect(asyncContext.server as unknown).toBe(server);
  });
});

test("run executes events.beforeRun inside the async run context", async () => {
  let beforeRunCalled = false;
  let callbackCalled = false;
  const harness = createCloudflareHarness({
    events: {
      beforeRun: async (workers) => {
        beforeRunCalled = true;
        const context = getCloudflareHarnessRunContext<{
          BACKEND: { configPath: string; name: string };
        }>();
        expect(context.workers.BACKEND as unknown).toEqual(workers.BACKEND as unknown);
        expect(callbackCalled).toBe(false);
      },
    },
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });

  await harness.run(() => {
    callbackCalled = true;
  });

  expect(beforeRunCalled).toBe(true);
  expect(callbackCalled).toBe(true);
});

test("parallel run calls use independent servers", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });
  let releaseSecondRun!: () => void;
  const secondRunReleasePromise = new Promise<void>((release) => {
    releaseSecondRun = release;
  });
  let secondRunStarted!: () => void;
  const secondRunStartedPromise = new Promise<void>((resolve) => {
    secondRunStarted = resolve;
  });

  const serversBefore = createdServers.length;
  const firstRun = harness.run(async () => {
    await Promise.resolve();
  });
  const secondRun = harness.run(async () => {
    secondRunStarted();
    await secondRunReleasePromise;
  });

  await secondRunStartedPromise;
  await firstRun;
  const runServers = createdServers.slice(serversBefore);

  try {
    expect(runServers).toHaveLength(2);
    expect(runServers[0].listenCalls).toBe(1);
    expect(runServers[0].closeCalls).toBe(1);
    expect(runServers[1].listenCalls).toBe(1);
    expect(runServers[1].closeCalls).toBe(0);
  } finally {
    releaseSecondRun();
    await secondRun;
  }
  expect(runServers[1].closeCalls).toBe(1);
});

test("run context throws outside harness.run", () => {
  expect(() => getCloudflareHarnessRunContext()).toThrow("Cloudflare harness run context is not active");
});

test("run streams worker runtime logs while the server is running", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml" },
    },
  });
  const originalConsoleLog = console.log;
  const consoleLogs: unknown[][] = [];
  console.log = (...args: unknown[]) => {
    consoleLogs.push(args);
  };

  try {
    await harness.run(async () => {
      const server = createdServers.at(-1)!;
      server.logs = [{ level: "info", message: "worker streamed" }];
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(consoleLogs).toEqual([["worker streamed"]]);
    });
  } finally {
    console.log = originalConsoleLog;
  }
});

test("run tolerates uncloneable worker runtime logs", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml" },
    },
  });
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  const dataCloneError = new DOMException("The object can not be cloned.", "DataCloneError");
  try {
    await harness.run(async () => {
      const server = createdServers.at(-1)!;
      server.getLogsError = dataCloneError;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    console.error = originalConsoleError;
  }

  const server = createdServers.at(-1)!;
  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
  expect(consoleErrors).toEqual([["[bun-test-cloudflare] Failed reading Worker runtime logs:"], [dataCloneError]]);
});

test("run closes the server after callback failure", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml" },
    },
  });
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    await expect(
      harness.run(() => {
        const server = createdServers.at(-1)!;
        server.logs = [{ level: "error", message: "worker failed" }];
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  } finally {
    console.error = originalConsoleError;
  }

  const server = createdServers.at(-1)!;
  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
  expect(consoleErrors).toEqual([["worker failed"]]);
});
