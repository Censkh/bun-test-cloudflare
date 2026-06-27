import { expect, mock, test } from "bun:test";

type FakeServer = {
  closeCalls: number;
  getWorkerCalls: string[];
  listenCalls: number;
  close: () => Promise<void>;
  getWorker: (name?: string) => { name?: string };
  listen: () => Promise<{ url: URL }>;
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
  getWorker(name?: string) {
    this.getWorkerCalls.push(String(name));
    return { name };
  },
  async listen() {
    this.listenCalls += 1;
    return { url: new URL("http://127.0.0.1:8787") };
  },
});

mock.module("wrangler", () => ({
  createTestHarness: (options: unknown) => {
    lastOptions = options;
    const server = createFakeServer();
    createdServers.push(server);
    return server;
  },
}));

const { createCloudflareHarness } = await import("bun-test-cloudflare");

test("passes worker configs to Wrangler while preserving typed worker keys", () => {
  const harness = createCloudflareHarness({
    root: "/repo",
    workers: {
      BACKEND: { configPath: "./wrangler.backend.toml", name: "backend-worker" },
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

  await expect(
    harness.run(() => {
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");

  expect(server.listenCalls).toBe(1);
  expect(server.closeCalls).toBe(1);
});
