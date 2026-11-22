import childProcess from "node:child_process";
import crypto from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import type { TestHarness, TestHarnessOptions, WorkerHandle } from "wrangler";
import { runWithCloudflareCaches } from "./CacheBridge";
import {
  configureFencedRun,
  createFencedBunCacheStorage,
  createFencedWorkerHandle,
  type FencedWorkerSpec,
} from "./FencedEnvBridge";
import { type CloudflareHarnessRunContext, type PreparedWorkerInput, runInHarnessContext } from "./HarnessRun";
import type { CloudflareHarnessConfig, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
import { readOwnCommandLine } from "./PrewarmedServerOrchestrator";
import { RunFence } from "./RunFence";
import type { HarnessRunLease, RunVariant, ServerOrchestrator } from "./ServerOrchestrator";
import type { SharedBrokerDaemonConfig, SharedBrokerEndpointInfo } from "./SharedSlotBrokerDaemon";

const BROKER_DIR = path.join(os.tmpdir(), "bun-test-cloudflare-brokers");
const DEFAULT_MAX_SHARED_SLOTS = 16;
const DEFAULT_BROKER_START_TIMEOUT_MS = 45_000;

const isProcessAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Extracts Bun's `--parallel` worker count from a parent process command line, if present. */
export const parseParallelCountFromArgs = (args: string): number | undefined => {
  const equalsMatch = /(?:^|\s)--parallel=(\d+)(?:\s|$)/.exec(args);
  if (equalsMatch) {
    const value = Number(equalsMatch[1]);
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
  const spaceMatch = /(?:^|\s)--parallel\s+(\d+)(?:\s|$)/.exec(args);
  if (spaceMatch) {
    const value = Number(spaceMatch[1]);
    return Number.isInteger(value) && value >= 1 ? value : undefined;
  }
  if (/(?:^|\s)--parallel(?:\s|$)/.test(args)) {
    return Math.max(1, os.availableParallelism());
  }
  return undefined;
};

const readParentParallelCount = (): number | undefined => {
  if (process.platform === "win32") return undefined;
  try {
    const result = childProcess.spawnSync("ps", ["-o", "args=", "-p", String(process.ppid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 1000,
    });
    if (result.status !== 0 || !result.stdout) return undefined;
    return parseParallelCountFromArgs(result.stdout.trim());
  } catch {
    return undefined;
  }
};

let cachedParentParallelCount: number | null | undefined;
const getParentParallelCount = (): number | undefined => {
  if (cachedParentParallelCount === undefined) {
    cachedParentParallelCount = readParentParallelCount() ?? null;
  }
  return cachedParentParallelCount ?? undefined;
};

export const shouldUseSharedSlotBroker = (): boolean => {
  if (process.platform === "win32") return false;
  if (process.env.BUN_TEST_CLOUDFLARE_SHARED_SLOTS === "0") return false;
  if (process.env.BUN_TEST_CLOUDFLARE_DISABLE_SERVER_PREWARM === "1") return false;

  const explicit = Number(process.env.BUN_TEST_CLOUDFLARE_SHARED_SLOTS);
  if (Number.isInteger(explicit) && explicit >= 2) return true;

  // A Bun test worker, which Bun starts with --test-worker: a test process that only inherited a
  // worker's environment (a fixture's `bun test` started from one) is a run of its own.
  if (!process.env.BUN_TEST_WORKER_ID) return false;
  const commandLine = readOwnCommandLine();
  if (commandLine !== null && !commandLine.split(/\s+/).includes("--test-worker")) return false;
  const parentParallel = getParentParallelCount();
  if (parentParallel === 1) return false;
  return true;
};

const registerWorkerPeer = (workersDir: string) => {
  mkdirSync(workersDir, { recursive: true });
  const workerId = process.env.BUN_TEST_WORKER_ID || String(process.pid);
  try {
    writeFileSync(path.join(workersDir, workerId), String(process.pid));
  } catch {}
};

const discoverPeerWorkerCount = async (workersDir: string): Promise<number> => {
  let maxCount = 1;
  let stableForMs = 0;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 200 && stableForMs < 60) {
    let current = 1;
    try {
      const entries = readdirSync(workersDir);
      current = Math.max(current, entries.length);
      for (const entry of entries) {
        const numeric = Number(entry);
        if (Number.isInteger(numeric) && numeric > current) current = numeric;
      }
    } catch {}
    if (current > maxCount) {
      maxCount = current;
      stableForMs = 0;
    } else {
      stableForMs += 20;
    }
    await Bun.sleep(20);
  }
  return maxCount;
};

const resolveSlotCount = async (configuredSlots: number, workersDir: string): Promise<number> => {
  const explicit = Number(process.env.BUN_TEST_CLOUDFLARE_SHARED_SLOTS);
  if (Number.isInteger(explicit) && explicit >= 2) return explicit;

  const maxSlots = Number(process.env.BUN_TEST_CLOUDFLARE_MAX_SHARED_SLOTS);
  const cap = Number.isInteger(maxSlots) && maxSlots >= 2 ? maxSlots : DEFAULT_MAX_SHARED_SLOTS;

  const parentParallel = getParentParallelCount();
  const workerCount = parentParallel ?? (await discoverPeerWorkerCount(workersDir));
  // Half the test processes, rounded up: the slots share one workerd process, so past that they
  // compete for it. 24 backend test files, three runs each, took 14.6 s with 2 slots for 4
  // processes (18.6 s with 5) and 17.3 s with 4 for 8 (44.3 s with 9).
  return Math.min(Math.max(configuredSlots, Math.ceil(workerCount / 2)), cap);
};

type LeaseResponse = {
  leaseId: string;
  proxyBindings: Record<string, string>;
  /** Where the lease's runtime takes ProxyClient requests. */
  proxyUrl: string;
  runId: string;
  serviceKey: string;
  slotIndex: number;
  slotSupervisorName: string;
};

type MiniflareClientModule = {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  ProxyClient: new (
    runtimeEntryURL: URL | string,
    dispatchFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  ) => {
    dispose(): Promise<void>;
    env: Record<string, any>;
    warm(): Promise<void>;
  };
};

let cachedMiniflareClient: MiniflareClientModule | undefined;
const getMiniflareClientModule = (): MiniflareClientModule => {
  if (!cachedMiniflareClient) {
    const wranglerRequire = createRequire(createRequire(import.meta.url).resolve("wrangler"));
    cachedMiniflareClient = wranglerRequire("miniflare") as MiniflareClientModule;
  }
  return cachedMiniflareClient;
};

// A broker is the daemon its endpoint names, with the run that started it still going: a daemon
// that was killed leaves its endpoint behind, and its pid, or its run's, can be another process's.
const isLiveBroker = (info: SharedBrokerEndpointInfo) => {
  if (!isProcessAlive(info.pid) || !isProcessAlive(info.parentPid)) return false;
  const command = childProcess.spawnSync("ps", ["-o", "command=", "-p", String(info.pid)]).stdout?.toString() ?? "";
  return command.includes("SharedSlotBrokerDaemon");
};

const readEndpoint = (endpointPath: string): SharedBrokerEndpointInfo | undefined => {
  try {
    const info = JSON.parse(readFileSync(endpointPath, "utf8")) as SharedBrokerEndpointInfo;
    if (info && typeof info.url === "string") return info;
  } catch {}
  return undefined;
};

const readLiveEndpoint = (endpointPath: string): SharedBrokerEndpointInfo | undefined => {
  const info = readEndpoint(endpointPath);
  return info && isLiveBroker(info) ? info : undefined;
};

/** Removes what brokers that are gone left behind: a killed daemon doesn't clean up after itself. */
const sweepGoneBrokers = () => {
  const keys = new Set(readdirSync(BROKER_DIR).flatMap((name) => /^([0-9a-f]{24})\./.exec(name)?.[1] ?? []));
  for (const key of keys) {
    const info = readEndpoint(path.join(BROKER_DIR, `${key}.json`));
    if (info && isLiveBroker(info)) continue;
    const lockPath = path.join(BROKER_DIR, `${key}.lock`);
    let lockOwner = 0;
    try {
      lockOwner = Number(readFileSync(lockPath, "utf8").trim());
    } catch {}
    // A broker whose lock a live process holds is starting, or serving; live peers are a run's.
    if (isProcessAlive(lockOwner)) continue;
    const workersDir = path.join(BROKER_DIR, `${key}.workers`);
    let peers: string[] = [];
    try {
      peers = readdirSync(workersDir).map((name) => readFileSync(path.join(workersDir, name), "utf8"));
    } catch {}
    if (peers.some((pid) => isProcessAlive(Number(pid)))) continue;
    for (const file of [`${key}.json`, `${key}.config.json`, `${key}.stderr.log`, `${key}.workers`, `${key}.lock`]) {
      rmSync(path.join(BROKER_DIR, file), { force: true, recursive: true });
    }
  }
};

const getBrokerStartTimeoutMs = () => {
  const value = Number(process.env.BUN_TEST_CLOUDFLARE_WARM_START_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_BROKER_START_TIMEOUT_MS;
};

const tryAcquireLock = (lockPath: string): boolean => {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    // Reclaim stale lock if its owner died before spawning a live broker.
    try {
      const ownerPid = Number(readFileSync(lockPath, "utf8").trim());
      if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
        rmSync(lockPath, { force: true });
        const fd = openSync(lockPath, "wx");
        writeFileSync(fd, `${process.pid}\n`);
        closeSync(fd);
        return true;
      }
    } catch {}
    return false;
  }
};

type SharedBrokerOrchestratorOptions<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  d1ResetMode?: "drop" | "truncate";
  events: CloudflareHarnessConfig<TWorkers>["events"];
  isolatedWorkerSlots: number;
  orchestratorKey: string;
  preparedWorkers: PreparedWorkerInput[];
  serverConfig: Omit<TestHarnessOptions, "workers">;
  workerEntries: Array<[keyof TWorkers, CloudflareWorkerConfig]>;
};

export class SharedBrokerServerOrchestrator<TWorkers extends Record<string, CloudflareWorkerConfig>>
  implements ServerOrchestrator<TWorkers>
{
  #closed = false;
  // Leases still out, which closing waits for: disposing the proxy client under a run still
  // settling cut its calls off ("other side closed") as its file's scope ended.
  #activeLeases = new Set<Promise<void>>();
  #endpointPromise: Promise<SharedBrokerEndpointInfo> | undefined;
  // The ProxyClient for the broker's runtime, at the proxy URL its leases give.
  #proxyClient: { url: string; client: Promise<InstanceType<MiniflareClientModule["ProxyClient"]>> } | undefined;
  readonly #brokerKey: string;

  constructor(private readonly options: SharedBrokerOrchestratorOptions<TWorkers>) {
    this.#brokerKey = crypto
      .createHash("sha256")
      .update(`${process.ppid}\n${options.orchestratorKey}`)
      .digest("hex")
      .slice(0, 24);
  }

  get closed() {
    return this.#closed;
  }

  #readLiveWorkerVars(): Record<string, Record<string, unknown>> {
    const result: Record<string, Record<string, unknown>> = {};
    for (let index = 0; index < this.options.workerEntries.length; index++) {
      const [, workerConfig] = this.options.workerEntries[index]!;
      const prepared = this.options.preparedWorkers[index]!;
      const topVars = "vars" in workerConfig && workerConfig.vars ? workerConfig.vars : undefined;
      const inlineVars =
        "config" in workerConfig &&
        workerConfig.config &&
        typeof workerConfig.config === "object" &&
        "vars" in workerConfig.config
          ? (workerConfig.config.vars as Record<string, unknown> | undefined)
          : undefined;
      const merged = { ...inlineVars, ...topVars };
      if (Object.keys(merged).length > 0) {
        result[prepared.name] = merged;
      }
    }
    return result;
  }

  async #ensureConnected(): Promise<{ endpoint: SharedBrokerEndpointInfo }> {
    const connecting = !this.#endpointPromise;
    this.#endpointPromise ??= this.#connectOrStartBroker();
    const endpoint = await this.#endpointPromise;
    if (process.env.BUN_TEST_CLOUDFLARE_TIMINGS === "1" && connecting) {
      process.stderr.write(
        `[bun-test-cloudflare] shared-broker connected pid=${endpoint.pid} slots=${endpoint.slotCount} worker=${process.env.BUN_TEST_WORKER_ID ?? process.pid}\n`,
      );
    }
    return { endpoint };
  }

  /** The ProxyClient for a lease's runtime: a broker started again since has another URL. */
  #proxyClientFor(proxyUrl: string) {
    if (this.#proxyClient?.url !== proxyUrl) {
      void this.#disposeProxyClient();
      const miniflare = getMiniflareClientModule();
      // Miniflare's fetch reads its init's dispatcher unconditionally, and a WebSocket upgrade
      // through the proxy dispatches without one.
      const client = new miniflare.ProxyClient(proxyUrl, (input, init) => miniflare.fetch(input, init ?? {}));
      this.#proxyClient = { url: proxyUrl, client: client.warm().then(() => client) };
    }
    return this.#proxyClient.client;
  }

  async #disposeProxyClient() {
    const current = this.#proxyClient;
    this.#proxyClient = undefined;
    await current?.client.then((client) => client.dispose()).catch(() => {});
  }

  async #connectOrStartBroker(): Promise<SharedBrokerEndpointInfo> {
    mkdirSync(BROKER_DIR, { recursive: true });
    const endpointPath = path.join(BROKER_DIR, `${this.#brokerKey}.json`);
    const lockPath = path.join(BROKER_DIR, `${this.#brokerKey}.lock`);
    const configPath = path.join(BROKER_DIR, `${this.#brokerKey}.config.json`);
    const stderrPath = path.join(BROKER_DIR, `${this.#brokerKey}.stderr.log`);
    const workersDir = path.join(BROKER_DIR, `${this.#brokerKey}.workers`);

    sweepGoneBrokers();
    registerWorkerPeer(workersDir);

    const existing = readLiveEndpoint(endpointPath);
    if (existing) return existing;

    let spawnedPid: number | undefined;
    if (tryAcquireLock(lockPath)) {
      const stillExisting = readLiveEndpoint(endpointPath);
      if (stillExisting) return stillExisting;

      const slotCount = await resolveSlotCount(this.options.isolatedWorkerSlots, workersDir);
      const token = crypto.randomUUID();
      const daemonConfig: SharedBrokerDaemonConfig = {
        brokerDir: BROKER_DIR,
        brokerKey: this.#brokerKey,
        configPath,
        d1ResetMode: this.options.d1ResetMode,
        endpointPath,
        lockPath,
        parentPid: process.ppid,
        preparedWorkers: this.options.preparedWorkers.map((worker) => ({
          input: worker.input,
          name: worker.name,
        })),
        serverConfig: this.options.serverConfig,
        slotCount,
        token,
      };
      writeFileSync(configPath, JSON.stringify(daemonConfig));
      rmSync(stderrPath, { force: true });

      const daemonScript = path.join(import.meta.dir, "SharedSlotBrokerDaemon.ts");
      // Started by a shell that leaves it running, in a process group of its own, and exits, so it
      // isn't this process's child: Bun kills a test file's child processes when the file ends,
      // and the broker serves every test process until the run ends.
      const started = childProcess.spawnSync(
        "/bin/sh",
        [
          "-c",
          'set -m; "$0" "$1" "$2" </dev/null >/dev/null 2>"$3" & echo $!',
          process.execPath,
          daemonScript,
          configPath,
          stderrPath,
        ],
        { env: process.env, stdio: ["ignore", "pipe", "pipe"] },
      );
      spawnedPid = Number(started.stdout?.toString().trim()) || undefined;
      if (spawnedPid === undefined) {
        throw new Error(`Failed starting the shared Cloudflare slot broker: ${started.stderr?.toString() ?? ""}`);
      }
    }

    const timeoutMs = getBrokerStartTimeoutMs();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const info = readLiveEndpoint(endpointPath);
      if (info) return info;
      if (spawnedPid !== undefined && !isProcessAlive(spawnedPid)) {
        const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
        throw new Error(
          `SharedSlotBrokerDaemon (pid ${spawnedPid}) exited before becoming ready${stderr ? `:\n${stderr}` : ""}`,
        );
      }
      await Bun.sleep(25);
    }

    const stderr = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    throw new Error(
      `Timed out waiting for shared Cloudflare slot broker after ${timeoutMs}ms${stderr ? `:\n${stderr}` : ""}`,
    );
  }

  /** Forgets a broker that stopped answering, so the next lease finds or starts a live one. */
  async #disconnect() {
    this.#endpointPromise = undefined;
    await this.#disposeProxyClient();
  }

  async #lease(liveVars: Record<string, Record<string, unknown>>) {
    const { endpoint } = await this.#ensureConnected();
    const response = await fetch(`${endpoint.url}/__btcf_broker/lease`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-btcf-broker-token": endpoint.token,
      },
      body: JSON.stringify({
        clientPid: process.pid,
        runtimeVarsByWorker: liveVars,
      }),
    });
    if (!response.ok) {
      throw new Error(`Failed leasing shared Cloudflare slot (${response.status}): ${await response.text()}`);
    }
    const lease = (await response.json()) as LeaseResponse;
    return { endpoint, lease, proxyClient: await this.#proxyClientFor(lease.proxyUrl) };
  }

  async acquire(): Promise<HarnessRunLease<TWorkers>> {
    const liveVars = this.#readLiveWorkerVars();
    // A broker whose runtime crashed, or that its parent's exit stopped, is gone for every test
    // process: one that can't be reached is replaced once, as a process's own runtime would be.
    const { endpoint, lease, proxyClient } = await this.#lease(liveVars).catch(async (error: unknown) => {
      const unreachable = error instanceof TypeError || /ECONNREFUSED|ECONNRESET|socket/i.test(String(error));
      if (this.#closed || !unreachable) throw error;
      await this.#disconnect();
      return this.#lease(liveVars);
    });

    const serviceFetcher = proxyClient.env[lease.serviceKey] as Fetcher;
    const remoteSupervisor = {
      fetch: (input: RequestInfo | URL, init?: RequestInit) => serviceFetcher.fetch(input as any, init as any),
      getEnv: async () =>
        Object.fromEntries(
          Object.entries(lease.proxyBindings).map(([supBinding, proxyKey]) => [supBinding, proxyClient.env[proxyKey]]),
        ),
    } as unknown as WorkerHandle;

    const fence = new RunFence();
    const workerSpecs = endpoint.workerSpecs as FencedWorkerSpec[];
    const createWorkers = (vars: Record<string, Record<string, unknown>>) =>
      Object.fromEntries(
        this.options.workerEntries.map(([key], workerIndex) => {
          const spec = workerSpecs[workerIndex]!;
          return [
            key,
            createFencedWorkerHandle({
              fence,
              runId: lease.runId,
              runtimeVars: vars[spec.name],
              secret: endpoint.fencedSecret,
              spec,
              supervisor: remoteSupervisor,
            }),
          ];
        }),
      ) as unknown as CloudflareWorkerMap<TWorkers>;
    let workers = createWorkers(liveVars);

    const cacheStorage = createFencedBunCacheStorage(remoteSupervisor, endpoint.fencedSecret, lease.runId, fence);

    // The run's runtime logs, read from the broker while the lease is held: getLogs is synchronous,
    // so it gives what the last read brought.
    let logs: ReturnType<TestHarness["getLogs"]> = [];
    let logsCleared = false;
    // Bumped by clearLogs, so a read that was on its way when the run cleared its logs is dropped.
    let logsGeneration = 0;
    const readLogs = async () => {
      const clear = logsCleared;
      logsCleared = false;
      const generation = logsGeneration;
      const response = await fetch(`${endpoint.url}/__btcf_broker/logs`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-btcf-broker-token": endpoint.token },
        body: JSON.stringify({ after: clear ? 0 : logs.length, clear, leaseId: lease.leaseId }),
      });
      if (!response.ok) return;
      const { logs: fresh } = (await response.json()) as { logs: typeof logs };
      if (generation !== logsGeneration) return;
      logs = clear ? fresh : [...logs, ...fresh];
    };
    let reading = false;
    const logPoll = setInterval(() => {
      if (reading) return;
      reading = true;
      void readLogs()
        .catch(() => {})
        .finally(() => {
          reading = false;
        });
    }, 50);

    const exposedServer: TestHarness = {
      listen: () => fence.dispatch(async () => ({ url: new URL(endpoint.url) })),
      fetch: (input, init) => {
        const primary = Object.values(workers)[0];
        if (!primary) throw new Error("Primary Worker is not available");
        return primary.fetch(input as any, init as any);
      },
      getWorker: (name) => {
        const index = this.options.workerEntries.findIndex(
          ([key, worker]) => name === undefined || name === (worker.name ?? String(key)),
        );
        if (index >= 0) {
          const [key] = this.options.workerEntries[index]!;
          return workers[key] as any;
        }
        throw new Error(`Unknown worker: ${String(name)}`);
      },
      getLogs: () => {
        fence.assertActive();
        return structuredClone(logs);
      },
      clearLogs: () => {
        fence.assertActive();
        logs = [];
        logsCleared = true;
        logsGeneration++;
      },
      debug: () => {
        fence.assertActive();
        return "";
      },
      update: () => fence.dispatch(async () => {}),
      reset: () => fence.dispatch(async () => {}),
      close: () => fence.dispatch(async () => {}),
    };

    const context: CloudflareHarnessRunContext<TWorkers> = {
      server: exposedServer,
      workers,
    };

    let released = false;
    const done = Promise.withResolvers<void>();
    this.#activeLeases.add(done.promise);
    const release = async () => {
      if (released) return;
      released = true;
      clearInterval(logPoll);
      this.#activeLeases.delete(done.promise);
      done.resolve();
      await fence.retire();
      await fetch(`${endpoint.url}/__btcf_broker/release`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-btcf-broker-token": endpoint.token,
        },
        body: JSON.stringify({ leaseId: lease.leaseId }),
      }).catch(() => {});
    };

    const run = {
      // The variant's vars and settings, sent to the slot this lease activated.
      configure: async (variant: RunVariant | undefined) => {
        if (!variant) return;
        const vars = { ...liveVars };
        for (const [name, overrides] of Object.entries(variant.vars)) vars[name] = { ...vars[name], ...overrides };
        await configureFencedRun(remoteSupervisor, endpoint.fencedSecret, lease.runId, vars, variant.settings);
        workers = createWorkers(vars);
        context.workers = workers;
      },
      execute: async <TResult>(
        callback: (w: CloudflareWorkerMap<TWorkers>, s: TestHarness) => Promise<TResult> | TResult,
      ) =>
        runInHarnessContext(context, () =>
          runWithCloudflareCaches(cacheStorage, async () => {
            await this.options.events?.beforeRun?.(workers, exposedServer);
            return callback(workers, exposedServer);
          }),
        ),
      settle: async () => {},
    } as any;

    return { release, run };
  }

  /**
   * Its slots live in the broker, so it holds no idle runtimes of its own: a file's harness parks it
   * (`parkOrchestrator`) for the next file's to take over, connection and all.
   */
  releaseIdleRuns() {}

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    await Promise.race([Promise.all(this.#activeLeases), Bun.sleep(30_000)]);
    await this.#disposeProxyClient();
  }
}
