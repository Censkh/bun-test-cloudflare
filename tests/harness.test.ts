import { afterAll, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type FakeWorker = {
  name?: string;
  getEnv: <TEnv = Record<string, any>>() => Promise<TEnv>;
};

type FakeServer = {
  closeCalls: number;
  getEnvError?: unknown;
  getWorkerCalls: string[];
  getLogsError?: unknown;
  listenCalls: number;
  close: () => Promise<void>;
  clearLogs: () => void;
  getLogs: () => unknown[];
  getWorker: (name?: string) => FakeWorker;
  listen: () => Promise<{ url: URL }>;
  logs: unknown[];
  reset: () => Promise<void>;
  resetCalls: number;
  update: () => Promise<void>;
  updateCalls: number;
  workerEnvs: Record<string, unknown>;
};

const createdServers: FakeServer[] = [];
const lifecycleEvents: string[] = [];
let lastOptions: unknown;
const spawnedCommands: string[][] = [];
const spawnedTimeouts: Array<number | undefined> = [];
let timedOutWranglerBuildsRemaining = 0;
let timedOutWranglerExitCode: null | 0 = null;
const testRoot = await mkdtemp(path.join(os.tmpdir(), "bun-test-cloudflare-harness-"));
const originalSpawn = Bun.spawn;
const originalSpawnSync = Bun.spawnSync;

const convertMockBindings = (config: Record<string, any>) => {
  if (config.__slotEligible) {
    return { SLOT_ELIGIBLE: { type: "plain_text", value: "true" } };
  }
  if (config.d1_databases || config.durable_objects || config.images || config.kv_namespaces || config.r2_buckets) {
    return {
      ...(config.d1_databases?.[0] ? { DB: { database_id: config.d1_databases[0].database_id, type: "d1" } } : {}),
      ...(config.durable_objects?.bindings?.[0]
        ? {
            COUNTER: {
              class_name: config.durable_objects.bindings[0].class_name,
              type: "durable_object_namespace",
            },
          }
        : {}),
      ...(config.images ? { IMAGES: { type: "images" } } : {}),
      ...(config.kv_namespaces?.[0] ? { KV: { id: config.kv_namespaces[0].id, type: "kv_namespace" } } : {}),
      ...(config.r2_buckets?.[0]
        ? { BUCKET: { bucket_name: config.r2_buckets[0].bucket_name, type: "r2_bucket" } }
        : {}),
      ...(config.vars
        ? Object.fromEntries(
            Object.entries(config.vars).map(([name, value]) => [
              name,
              typeof value === "string" ? { type: "plain_text", value } : { type: "json", value },
            ]),
          )
        : {}),
    };
  }
  if (config.services?.[0]) {
    return {
      EXTERNAL: { service: config.services[0].service, type: "service" },
    };
  }
  return { UNSUPPORTED: { type: "browser" } };
};

const wranglerMock = {
  createTestHarness: (options: unknown) => {
    lastOptions = options;
    const server = createFakeServer();
    createdServers.push(server);
    return server;
  },
  unstable_readConfig: ({ config }: { config: string }) => ({
    __slotEligible: config.includes("eligible"),
    compatibility_date: "2025-08-15",
    define: {
      "process.env.NODE_ENV": "'production'",
    },
    main: config.includes("cms") ? "src/cms.ts" : "src/backend.ts",
    name: config.includes("cms") ? "cms-worker" : "backend-worker",
    rules: [],
    triggers: {},
  }),
  unstable_convertConfigBindingsToStartWorkerBindings: convertMockBindings,
};

const createFakeServer = (): FakeServer => ({
  closeCalls: 0,
  getWorkerCalls: [],
  listenCalls: 0,
  async close() {
    lifecycleEvents.push("closed");
    this.closeCalls += 1;
  },
  clearLogs() {
    this.logs = [];
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
      value: async () => {
        if (this.getEnvError) {
          throw this.getEnvError;
        }
        return this.workerEnvs[String(name)] ?? {};
      },
    });
    return worker as FakeWorker;
  },
  async listen() {
    this.listenCalls += 1;
    return { url: new URL("http://127.0.0.1:8787") };
  },
  logs: [],
  async reset() {
    this.resetCalls += 1;
  },
  resetCalls: 0,
  async update() {
    this.updateCalls += 1;
  },
  updateCalls: 0,
  workerEnvs: {},
});

mock.module("wrangler", () => wranglerMock);

const runFakeWranglerBuild = (command: string[]) => {
  const outdir = command[command.indexOf("--outdir") + 1];
  const configPath = command[command.indexOf("--config") + 1];
  const builtFile = configPath.includes("cms") ? "cms.js" : "backend.js";

  mkdirSync(outdir, { recursive: true });
  writeFileSync(path.join(outdir, builtFile), "export default {};");
};

Bun.spawnSync = ((options: { cmd: string[]; timeout?: number }) => {
  spawnedCommands.push(options.cmd);
  spawnedTimeouts.push(options.timeout);
  if (options.cmd.includes("deploy") && options.cmd.includes("--dry-run") && timedOutWranglerBuildsRemaining > 0) {
    timedOutWranglerBuildsRemaining -= 1;
    return {
      exitCode: timedOutWranglerExitCode,
      signalCode: "SIGTERM",
      stderr: Buffer.from(""),
      stdout: Buffer.from(""),
    };
  }
  runFakeWranglerBuild(options.cmd);
  return {
    exitCode: 0,
    stderr: Buffer.from(""),
    stdout: Buffer.from(""),
  };
}) as typeof Bun.spawnSync;

Bun.spawn = ((...args: Parameters<typeof Bun.spawn>) => {
  const [command] = args;
  spawnedCommands.push(command);
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
const { closePrewarmedServerOrchestrators, WARM_WORKERD_POOL_SIZE } = await import(
  "../src/PrewarmedServerOrchestrator"
);

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
  for (const configPath of configPaths) {
    expect(JSON.parse(readFileSync(configPath, "utf8")).find_additional_modules).toBe(false);
  }

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

test("retries a timed-out Wrangler dry-run build", async () => {
  const commandStart = spawnedCommands.length;
  const timeoutStart = spawnedTimeouts.length;
  timedOutWranglerBuildsRemaining = 1;

  const harness = createCloudflareHarness({
    root: testRoot,
    workers: {
      BACKEND: {
        config: {
          compatibility_date: "2025-08-15",
          main: "src/backend.ts",
          name: "retry-backend",
        },
      },
    },
  });

  await harness.run(() => {});

  const retryCommands = spawnedCommands.slice(commandStart);
  expect(retryCommands).toHaveLength(2);
  expect(retryCommands.every((command) => command.includes("--dry-run"))).toBe(true);
  expect(
    spawnedTimeouts
      .slice(timeoutStart)
      .every((timeout) => timeout !== undefined && timeout >= 29_000 && timeout <= 30_000),
  ).toBe(true);
});

test("retries when Bun reports a timed-out Wrangler build with exit code zero", async () => {
  const commandStart = spawnedCommands.length;
  timedOutWranglerBuildsRemaining = 1;
  timedOutWranglerExitCode = 0;

  const harness = createCloudflareHarness({
    root: testRoot,
    workers: {
      BACKEND: {
        config: {
          compatibility_date: "2025-08-15",
          main: "src/backend.ts",
          name: "zero-exit-timeout-backend",
        },
      },
    },
  });

  await harness.run(() => {});

  expect(spawnedCommands.slice(commandStart)).toHaveLength(2);
  timedOutWranglerExitCode = null;
});

test("copies explicit additional modules without recursively copying harness build output", async () => {
  const moduleRoot = path.join(testRoot, "copy-additional-modules");
  const sourceModulePath = path.join(moduleRoot, "node_modules/payload/dist/uploads/isImage.js");
  const outsideModulePath = path.join(testRoot, "outside.wasm");
  const staleOutdirModulePath = path.join(moduleRoot, "node_modules/.btcf/worker-build/copy-modules-cms/stale.wasm");
  const activeSlotWrapperPath = path.join(
    moduleRoot,
    "node_modules/.btcf/worker-build/copy-modules-cms/copy-modules-cms--btcf-slot-0.test.cache-bridge.js",
  );
  const staleHarnessModulePath = path.join(
    moduleRoot,
    "node_modules/.btcf/worker-build/stale-worker/node_modules/payload/dist/uploads/stale.js",
  );
  mkdirSync(path.dirname(sourceModulePath), { recursive: true });
  mkdirSync(path.dirname(staleHarnessModulePath), { recursive: true });
  mkdirSync(path.dirname(staleOutdirModulePath), { recursive: true });
  writeFileSync(path.join(moduleRoot, "package.json"), JSON.stringify({ private: true, workspaces: [] }));
  writeFileSync(sourceModulePath, "export const isImage = () => true;\n");
  writeFileSync(outsideModulePath, "outside");
  writeFileSync(staleHarnessModulePath, "export const stale = true;\n");
  writeFileSync(staleOutdirModulePath, "stale");
  writeFileSync(activeSlotWrapperPath, "export default {};\n");

  const harness = createCloudflareHarness({
    root: moduleRoot,
    workers: {
      CMS: {
        config: {
          compatibility_date: "2025-08-15",
          find_additional_modules: true,
          main: "src/cms.ts",
          name: "copy-modules-cms",
          rules: [
            { type: "ESModule", globs: ["node_modules/payload/dist/uploads/*.js"] },
            { type: "CompiledWasm", globs: ["**/*.wasm"] },
          ],
        },
        name: "copy-modules-cms",
      },
    },
  });

  await harness.run(() => {});

  const outdir = path.join(moduleRoot, "node_modules/.btcf/worker-build/copy-modules-cms");
  expect(existsSync(staleOutdirModulePath)).toBe(false);
  expect(existsSync(activeSlotWrapperPath)).toBe(true);
  expect(existsSync(path.join(outdir, "node_modules/payload/dist/uploads/isImage.js"))).toBe(true);
  expect(existsSync(path.join(outdir, "outside.wasm"))).toBe(false);
  expect(
    existsSync(
      path.join(outdir, "node_modules/.btcf/worker-build/stale-worker/node_modules/payload/dist/uploads/stale.js"),
    ),
  ).toBe(false);
  expect(JSON.parse(readFileSync(path.join(outdir, "wrangler.json"), "utf8")).find_additional_modules).toBe(false);
  expect(lastOptions).toEqual({
    root: moduleRoot,
    workers: [
      {
        config: expect.objectContaining({
          base_dir: outdir,
          find_additional_modules: true,
          main: path.join(outdir, "worker.js"),
          no_bundle: true,
          rules: [
            { type: "ESModule", globs: ["node_modules/payload/dist/uploads/*.js"] },
            { type: "CompiledWasm", globs: ["**/*.wasm"] },
            { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
          ],
        }),
      },
    ],
  });
});

test("run starts the server, passes typed workers, and resets it before reuse", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
      CMS: { configPath: "./wrangler.cms.toml", name: "cms-worker" },
    },
  });

  let server!: FakeServer;
  const result = await harness.run((workers, currentServer) => {
    server = currentServer as unknown as FakeServer;
    expect(workers.BACKEND as unknown).toEqual({ name: "backend-worker" });
    expect(workers.CMS as unknown).toEqual({ name: "cms-worker" });
    return "ok";
  });

  expect(result).toBe("ok");
  expect(server.listenCalls).toBe(1);
  expect(server.resetCalls).toBe(0);
  expect(server.updateCalls).toBe(0);
  expect(server.closeCalls).toBe(0);

  await harness.run(() => {});
  await harness.run((_workers, currentServer) => {
    expect(currentServer as unknown).toBe(server as unknown);
  });

  expect(server.resetCalls).toBe(2);
  expect(server.updateCalls).toBe(0);
  expect(server.closeCalls).toBe(0);
});

test("run exposes workers and server through async run context", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });

  await harness.run(async (workers, server) => {
    const context = getCloudflareHarnessRunContext<{
      BACKEND: { configPath: string; name: string };
    }>();

    expect(context.server as unknown).toBe(server as unknown);
    expect(context.workers.BACKEND as unknown).toEqual(workers.BACKEND as unknown);

    await Promise.resolve();

    const asyncContext = getCloudflareHarnessRunContext<{
      BACKEND: { configPath: string; name: string };
    }>();
    expect(asyncContext.server as unknown).toBe(server as unknown);
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
    prewarmedWorkerdPoolSize: 2,
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
  let firstServer!: FakeServer;
  let secondServer!: FakeServer;
  const firstRun = harness.run(async (_workers, server) => {
    firstServer = server as unknown as FakeServer;
    await Promise.resolve();
  });
  const secondRun = harness.run(async (_workers, server) => {
    secondServer = server as unknown as FakeServer;
    secondRunStarted();
    await secondRunReleasePromise;
  });

  await secondRunStartedPromise;
  await firstRun;

  try {
    expect(createdServers.length - serversBefore).toBe(0);
    expect(firstServer).not.toBe(secondServer);
    expect(firstServer.listenCalls).toBe(1);
    expect(firstServer.updateCalls).toBe(0);
    expect(firstServer.closeCalls).toBe(0);
    expect(secondServer.listenCalls).toBe(1);
    expect(secondServer.closeCalls).toBe(0);
  } finally {
    releaseSecondRun();
    await secondRun;
  }
  expect(secondServer.updateCalls).toBe(0);
  expect(secondServer.closeCalls).toBe(0);
});

test("prewarms the configured server pool and refills it after a lease is released", async () => {
  const serversBefore = createdServers.length;
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });
  const initialWarmServers = createdServers.slice(serversBefore);

  expect(initialWarmServers).toHaveLength(WARM_WORKERD_POOL_SIZE);
  expect(initialWarmServers.every((server) => server.listenCalls === 1)).toBe(true);

  let leasedServer!: FakeServer;
  await harness.run((_workers, server) => {
    leasedServer = server as unknown as FakeServer;
    expect(initialWarmServers).toContain(leasedServer);
    expect(createdServers.slice(serversBefore)).toHaveLength(WARM_WORKERD_POOL_SIZE);
  });

  const harnessServers = createdServers.slice(serversBefore);
  expect(harnessServers).toHaveLength(WARM_WORKERD_POOL_SIZE);
  expect(leasedServer.updateCalls).toBe(0);
  expect(leasedServer.closeCalls).toBe(0);
  expect(harnessServers.filter((server) => server.closeCalls === 0)).toHaveLength(WARM_WORKERD_POOL_SIZE);

  await closePrewarmedServerOrchestrators();
  expect(harnessServers.every((server) => server.closeCalls === 1)).toBe(true);
});

test("supports a configured prewarmed workerd pool size", async () => {
  const serversBefore = createdServers.length;
  const harness = createCloudflareHarness({
    prewarmedWorkerdPoolSize: 2,
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });

  expect(createdServers.slice(serversBefore)).toHaveLength(2);
  await harness.run(() => {});
  expect(createdServers.slice(serversBefore)).toHaveLength(2);
});

test("uses four isolated slots and one prewarmed workerd by default when eligible", () => {
  const serversBefore = createdServers.length;
  createCloudflareHarness({
    workers: {
      BACKEND: {
        configPath: "./wrangler.eligible.toml",
        name: "backend-worker",
      },
    },
  });

  expect(createdServers.slice(serversBefore)).toHaveLength(1);
  expect((lastOptions as { workers: unknown[] }).workers).toHaveLength(4);
});

test("discards stale prewarmed servers before leasing them", async () => {
  const serversBefore = createdServers.length;
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
    },
  });
  const initialWarmServers = createdServers.slice(serversBefore);
  initialWarmServers[0].getEnvError = new Error("poisoned warm server");

  let leasedServer!: FakeServer;
  await harness.run((_workers, server) => {
    leasedServer = server as unknown as FakeServer;
  });

  expect(leasedServer).not.toBe(initialWarmServers[0]);
  expect(initialWarmServers[0].closeCalls).toBe(1);
  expect(leasedServer.updateCalls).toBe(0);
  expect(leasedServer.closeCalls).toBe(0);

  await closePrewarmedServerOrchestrators();
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
  let server!: FakeServer;
  try {
    await harness.run(async (_workers, currentServer) => {
      server = currentServer as unknown as FakeServer;
      server.getLogsError = dataCloneError;
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  } finally {
    console.error = originalConsoleError;
  }

  expect(server.listenCalls).toBe(1);
  expect(server.updateCalls).toBe(0);
  expect(server.closeCalls).toBe(0);
  expect(consoleErrors).toEqual([["[bun-test-cloudflare] Failed reading Worker runtime logs:"], [dataCloneError]]);
});

test("run fails after cleanup when Worker waitUntil work rejects", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml" },
    },
  });
  const originalConsoleError = console.error;
  console.error = () => {};

  let server!: FakeServer;
  try {
    await expect(
      harness.run((_workers, currentServer) => {
        server = currentServer as unknown as FakeServer;
        server.logs = [{ level: "error", message: "waitUntil - Promise failed with error: background task failed" }];
      }),
    ).rejects.toThrow(/Worker waitUntil promise rejection:[\s\S]*background task failed/);
  } finally {
    console.error = originalConsoleError;
  }

  expect(server.closeCalls).toBe(1);
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

  let server!: FakeServer;
  try {
    await expect(
      harness.run((_workers, currentServer) => {
        server = currentServer as unknown as FakeServer;
        server.logs = [{ level: "error", message: "worker failed" }];
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  } finally {
    console.error = originalConsoleError;
  }

  expect(server.listenCalls).toBe(1);
  expect(server.updateCalls).toBe(0);
  expect(server.closeCalls).toBe(0);
  expect(consoleErrors).toEqual([["worker failed"]]);
});
