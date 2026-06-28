import { expect, mock, test } from "bun:test";

type FakeServer = {
  closeCalls: number;
  getWorkerCalls: string[];
  listenCalls: number;
  close: () => Promise<void>;
  getLogs: () => unknown[];
  getWorker: (name?: string) => { name?: string };
  listen: () => Promise<{ url: URL }>;
  logs: unknown[];
};

const createdServers: FakeServer[] = [];
let lastOptions: unknown;

const createFakeServer = (): FakeServer => ({
  closeCalls: 0,
  getWorkerCalls: [],
  listenCalls: 0,
  async close() {
    this.closeCalls += 1;
  },
  getLogs() {
    return this.logs;
  },
  getWorker(name?: string) {
    this.getWorkerCalls.push(String(name));
    return { name };
  },
  async listen() {
    this.listenCalls += 1;
    return { url: new URL("http://127.0.0.1:8787") };
  },
  logs: [],
});

mock.module("wrangler", () => ({
  createTestHarness: (options: unknown) => {
    lastOptions = options;
    const server = createFakeServer();
    createdServers.push(server);
    return server;
  },
}));

const { createCloudflareHarness, typeToken } = await import("bun-test-cloudflare");

type Equal<TActual, TExpected> =
  (<T>() => T extends TActual ? 1 : 2) extends <T>() => T extends TExpected ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

test("passes worker configs to Wrangler while preserving typed worker keys", () => {
  const harness = createCloudflareHarness({
    root: "/repo",
    workers: {
      BACKEND: {
        bindings: typeToken<{ IMAGES_BUCKET: { put: (key: string, value: Uint8Array) => Promise<void> } }>(),
        configPath: "./wrangler.backend.toml",
        name: "backend-worker",
      },
      CMS: { configPath: "./wrangler.cms.toml", vars: { APP_ENV: "test" } },
    },
  });

  expect(lastOptions).toEqual({
    root: "/repo",
    workers: [
      { configPath: "./wrangler.backend.toml" },
      { configPath: "./wrangler.cms.toml", vars: { APP_ENV: "test" } },
    ],
  });

  const workers = harness.workers();
  expect(workers.BACKEND as unknown).toEqual({ name: "backend-worker" });
  expect(workers.CMS as unknown).toEqual({ name: "CMS" });

  type BackendEnv = Awaited<ReturnType<(typeof workers)["BACKEND"]["getEnv"]>>;
  type _BackendEnvMatches = Expect<
    Equal<BackendEnv, { IMAGES_BUCKET: { put: (key: string, value: Uint8Array) => Promise<void> } }>
  >;
});

test("run starts the server, passes typed workers, and closes after success", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
      CMS: { configPath: "./wrangler.cms.toml", name: "cms-worker" },
    },
  });
  const server = createdServers.at(-1)!;

  const result = await harness.run((workers, currentServer) => {
    expect(currentServer as unknown).toBe(server);
    expect(workers.BACKEND as unknown).toEqual({ name: "backend-worker" });
    expect(workers.CMS as unknown).toEqual({ name: "cms-worker" });
    return "ok";
  });

  expect(result).toBe("ok");
  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
});

test("run closes the server after callback failure", async () => {
  const harness = createCloudflareHarness({
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml" },
    },
  });
  const server = createdServers.at(-1)!;
  server.logs = [{ level: "error", message: "worker failed" }];
  const originalConsoleError = console.error;
  const consoleErrors: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    await expect(
      harness.run(() => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  } finally {
    console.error = originalConsoleError;
  }

  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
  expect(consoleErrors).toEqual([
    ["[bun-test-cloudflare] Worker runtime logs before failure:"],
    [JSON.stringify({ level: "error", message: "worker failed" })],
  ]);
});
