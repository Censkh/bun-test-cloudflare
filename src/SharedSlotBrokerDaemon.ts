import crypto from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { TestHarnessOptions } from "wrangler";
import { shouldInstallCompatibilityPatch, shouldInstallCompatibilityPatchGroup } from "./CompatibilityPatches";
import type { FencedRunSettings } from "./FencedEnvBridge";
import { installBrowserRenderingPatch } from "./patches/BrowserRenderingPatch";
import { installChildProcessExtraFdPatch } from "./patches/ChildProcessExtraFdPatch";
import { installMiniflareLoopbackPatch } from "./patches/MiniflareLoopbackPatch";
import { installMiniflarePatch } from "./patches/MiniflarePatch";
import { installMiniflareSourcePatch } from "./patches/MiniflareSourcePatch";
import { installMiniflareWebGlobalsPatch } from "./patches/MiniflareWebGlobalsPatch";
import { installUndiciPatch } from "./patches/UndiciPatch";
import { installWebStreamPatch } from "./patches/WebStreamPatch";
import { installWebsocketPatch } from "./patches/WebsocketPatch";
import { installWorkerdChildProcessPatch } from "./patches/WorkerdChildProcessPatch";
import { installWorkerThreadsPatch } from "./patches/WorkerThreadsPatch";
import { installWranglerBunDetectionPatch } from "./patches/WranglerBunDetectionPatch";
import { installWsCloseHandshakePatch } from "./patches/WsCloseHandshakePatch";

// Install Bun compatibility patches before importing wrangler or miniflare.
if (
  shouldInstallCompatibilityPatchGroup("web-streams", [
    "web-streams-readable-constructor",
    "web-streams-writable-constructor",
    "web-streams-readable-prototype",
    "web-streams-writable-prototype",
  ])
) {
  installWebStreamPatch();
}
if (!shouldInstallCompatibilityPatch("websocket") && shouldInstallCompatibilityPatch("ws-close-handshake")) {
  installWsCloseHandshakePatch();
}
if (shouldInstallCompatibilityPatch("child-process-extra-fd")) {
  installChildProcessExtraFdPatch();
}
installWorkerdChildProcessPatch();
if (shouldInstallCompatibilityPatchGroup("browser-rendering", ["browser-rendering-spawn"])) {
  installBrowserRenderingPatch();
}
if (shouldInstallCompatibilityPatch("undici")) {
  installUndiciPatch();
}
if (shouldInstallCompatibilityPatch("websocket")) {
  installWebsocketPatch();
}
if (shouldInstallCompatibilityPatch("worker-threads")) {
  installWorkerThreadsPatch();
}
installMiniflareSourcePatch({
  capnpArenaGrowth: shouldInstallCompatibilityPatch("miniflare-capnp-arena-growth"),
  proxyCallRetention: shouldInstallCompatibilityPatch("miniflare-proxy-call-retention"),
  stoppableSocketTracking: shouldInstallCompatibilityPatch("miniflare-stoppable-socket-tracking"),
  loopbackBodyCancellation: shouldInstallCompatibilityPatch("miniflare-loopback-body-cancellation"),
});
if (shouldInstallCompatibilityPatch("miniflare-web-globals")) {
  installMiniflareWebGlobalsPatch();
}
if (
  shouldInstallCompatibilityPatchGroup("miniflare-loopback", ["miniflare-loopback-launch", "miniflare-loopback-close"])
) {
  installMiniflareLoopbackPatch();
}
if (shouldInstallCompatibilityPatchGroup("miniflare", ["miniflare-platform-proxy-dispatch"])) {
  installMiniflarePatch();
}
if (shouldInstallCompatibilityPatch("wrangler-bun-detection")) {
  installWranglerBunDetectionPatch();
}

export type SharedBrokerDaemonConfig = {
  brokerDir: string;
  brokerKey: string;
  configPath: string;
  d1ResetMode?: "drop" | "truncate";
  endpointPath: string;
  lockPath: string;
  parentPid: number;
  preparedWorkers: Array<{ input: TestHarnessOptions["workers"][number]; name: string }>;
  serverConfig: Omit<TestHarnessOptions, "workers">;
  slotCount: number;
  token: string;
};

export type SharedBrokerEndpointInfo = {
  supportsGetExport: boolean;
  fencedSecret: string;
  parentPid: number;
  pid: number;
  slotCount: number;
  token: string;
  url: string;
  workerSpecs: unknown[];
};

const isProcessAlive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readJsonBody = (req: http.IncomingMessage): Promise<any> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });

const sendJson = (res: http.ServerResponse, status: number, body: unknown) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-length": Buffer.byteLength(payload),
    "content-type": "application/json",
  });
  res.end(payload);
};

const runDaemon = async () => {
  const configPath = process.argv[2];
  if (!configPath) {
    throw new Error("SharedSlotBrokerDaemon requires a config file path argument");
  }
  const config = JSON.parse(readFileSync(configPath, "utf8")) as SharedBrokerDaemonConfig;

  const [
    { createTestHarness },
    { activateFencedSlot, retireFencedSlot },
    { cleanupFencedWorkerSlots, createFencedWorkerSlots },
    { createRuntimeCrashMonitor, runWithWorkerdProcessOwner },
    {
      devEnvCaptureContext,
      disposeCapturedMiniflareRuntimes,
      installWranglerPatches,
      runWithTestHarnessPersistencePath,
    },
  ] = await Promise.all([
    import("wrangler"),
    import("./FencedEnvBridge"),
    import("./FencedWorkerSlots"),
    import("./WorkerRuntimeCrash"),
    import("./wranglerPatches"),
  ]);
  installWranglerPatches();

  const wranglerRequire = createRequire(createRequire(import.meta.url).resolve("wrangler"));
  const miniflareModule = wranglerRequire("miniflare") as {
    CoreBindings: {
      DURABLE_OBJECT_NAMESPACE_PROXY: string;
      SERVICE_USER_ROUTE_PREFIX: string;
    };
    CoreHeaders: { OP_SECRET: string };
    ProxyClient: new (
      runtimeEntryURL: URL | string,
      dispatchFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    ) => {
      dispose(): Promise<void>;
      env: Record<string, any>;
    };
  };

  const opSecretHeaderLower = miniflareModule.CoreHeaders.OP_SECRET.toLowerCase();

  const fencedSlots = createFencedWorkerSlots(config.preparedWorkers, config.slotCount, {
    d1ResetMode: config.d1ResetMode,
  });

  type Slot = { index: number; runtime: Runtime };
  type Runtime = {
    server: ReturnType<typeof createTestHarness>;
    capturedDevEnvs: Array<{ runtimes?: Array<{ mf?: any }> }>;
    storageRoot: string;
    proxyServer: http.Server;
    upgradeServer: net.Server;
    upgradeUrl: string;
    proxyUrl: string;
    slotProxyBindings: Record<string, Record<string, string>>;
    slotServiceKeys: Record<string, string>;
    freeSlots: number[];
  };

  /** Forwards Miniflare ProxyClient requests from test processes to one runtime, with its secret. */
  const createProxyServer = async (runtimeEntryURL: URL, brokerProxySecret: string) => {
    const proxyServer = http.createServer((req, res) => {
      const headers: http.OutgoingHttpHeaders = { ...req.headers };
      headers.host = runtimeEntryURL.host;
      if (headers[opSecretHeaderLower] !== undefined) headers[opSecretHeaderLower] = brokerProxySecret;
      const upstream = http.request(
        {
          headers,
          hostname: runtimeEntryURL.hostname,
          method: req.method,
          path: req.url ?? "/",
          port: Number(runtimeEntryURL.port),
        },
        (upstreamRes) => {
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      upstream.on("error", (error) => {
        if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
        res.end(error instanceof Error ? error.message : String(error));
      });
      req.pipe(upstream);
    });
    // Bun 1.3's node:http upgrade socket cannot pipe a raw handshake back to the client.
    // Accept upgrades on a TCP listener so the runtime handles the handshake and frames itself.
    const upgradeServer = net.createServer((socket) => {
      let pending = Buffer.alloc(0);
      socket.setTimeout(10_000, () => socket.destroy());
      socket.on("error", () => socket.destroy());
      const readHandshake = (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        const end = pending.indexOf("\r\n\r\n");
        if (end === -1) {
          if (pending.length > http.maxHeaderSize) socket.destroy();
          return;
        }
        const lines = pending.toString("latin1", 0, end).split("\r\n");
        if (
          end > http.maxHeaderSize ||
          !lines[0]?.startsWith("GET ") ||
          !lines.some((line) => /^upgrade:\s*websocket\s*$/i.test(line))
        ) {
          socket.destroy();
          return;
        }
        socket.pause();
        socket.off("data", readHandshake);
        socket.setTimeout(0);
        const upstream = net.connect(Number(runtimeEntryURL.port), runtimeEntryURL.hostname, () => {
          for (let i = 1; i < lines.length; i++) {
            const name = lines[i]!.split(":", 1)[0]!.toLowerCase();
            if (name === "host") lines[i] = `Host: ${runtimeEntryURL.host}`;
            if (name === opSecretHeaderLower) lines[i] = `${name}: ${brokerProxySecret}`;
          }
          upstream.write(`${lines.join("\r\n")}\r\n\r\n`, "latin1");
          upstream.write(pending.subarray(end + 4));
          pending = Buffer.alloc(0);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        socket.on("close", () => upstream.destroy());
        upstream.on("error", () => socket.destroy());
        upstream.on("close", () => socket.destroy());
      };
      socket.on("data", readHandshake);
    });
    // No idle timeout: test processes reuse a kept-alive connection, and one the server closed after
    // Node's 5 s default while a process waited for a slot or ran a long test was reset as its next
    // request went out on it ("fetch failed").
    proxyServer.keepAliveTimeout = 0;
    const listen = async (server: http.Server | net.Server) => {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
      });
      const { port } = server.address() as net.AddressInfo;
      return `http://127.0.0.1:${port}`;
    };
    const proxyUrl = await listen(proxyServer);
    try {
      return { proxyServer, proxyUrl, upgradeServer, upgradeUrl: await listen(upgradeServer) };
    } catch (error) {
      proxyServer.close();
      throw error;
    }
  };

  const startRuntime = async (): Promise<Runtime> => {
    const storageRoot = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-broker-storage-"));
    const capturedDevEnvs: Array<{ runtimes?: Array<{ mf?: any }> }> = [];
    const server = createTestHarness({ ...config.serverConfig, workers: fencedSlots.inputs });
    await runWithTestHarnessPersistencePath(storageRoot, () =>
      devEnvCaptureContext.run(capturedDevEnvs as any, () =>
        runWithWorkerdProcessOwner(createRuntimeCrashMonitor(), () => server.listen()),
      ),
    );
    const mf = capturedDevEnvs.find((devEnv) => devEnv.runtimes?.[0]?.mf)?.runtimes?.[0]?.mf;
    if (!mf) throw new Error("SharedSlotBrokerDaemon could not locate Miniflare runtime");
    const runtimeEntryURL = (await mf.ready) as URL;
    const proxyClient = await mf._getProxyClient();

    // Capture this process's Miniflare ProxyClient secret via an async Fetcher call so we can
    // rewrite MF-Op-Secret on proxied requests from peer Bun worker processes.
    let brokerProxySecret = "";
    const firstSlotServiceKey = `${miniflareModule.CoreBindings.SERVICE_USER_ROUTE_PREFIX}${fencedSlots.slotSupervisorNames[0]}`;
    const secretProbe = new miniflareModule.ProxyClient(runtimeEntryURL, async (input, init) => {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      brokerProxySecret = headers.get(miniflareModule.CoreHeaders.OP_SECRET) ?? "";
      return new Response("ok", { status: 200 });
    });
    try {
      await secretProbe.env[firstSlotServiceKey].fetch("https://bun-test-cloudflare.invalid/__btcf_secret_probe");
    } finally {
      await secretProbe.dispose().catch(() => {});
    }
    if (!brokerProxySecret) throw new Error("Failed to capture Miniflare ProxyClient secret in SharedSlotBrokerDaemon");

    const proxyPrefix = `${miniflareModule.CoreBindings.DURABLE_OBJECT_NAMESPACE_PROXY}:`;
    const envKeys = Reflect.ownKeys(proxyClient.env).filter((key): key is string => typeof key === "string");
    const slotProxyBindings: Record<string, Record<string, string>> = {};
    const slotServiceKeys: Record<string, string> = {};
    for (const slotSupervisorName of fencedSlots.slotSupervisorNames) {
      slotServiceKeys[slotSupervisorName] =
        `${miniflareModule.CoreBindings.SERVICE_USER_ROUTE_PREFIX}${slotSupervisorName}`;
      const bindings: Record<string, string> = {};
      for (const key of envKeys) {
        if (!key.startsWith(proxyPrefix)) continue;
        // Format: MINIFLARE_PROXY:<plugin>:<workerName>:<bindingName>
        const rest = key.slice(proxyPrefix.length);
        const firstColon = rest.indexOf(":");
        if (firstColon < 0) continue;
        const afterPlugin = rest.slice(firstColon + 1);
        const expectedPrefix = `${slotSupervisorName}:`;
        if (afterPlugin.startsWith(expectedPrefix)) bindings[afterPlugin.slice(expectedPrefix.length)] = key;
      }
      slotProxyBindings[slotSupervisorName] = bindings;
    }
    const proxy = await createProxyServer(runtimeEntryURL, brokerProxySecret);
    return {
      server,
      capturedDevEnvs,
      storageRoot,
      ...proxy,
      slotProxyBindings,
      slotServiceKeys,
      freeSlots: Array.from({ length: config.slotCount }, (_, index) => index),
    };
  };

  const closeRuntime = async (runtime: Runtime) => {
    try {
      runtime.upgradeServer.close();
      runtime.proxyServer.close();
    } catch {}
    await runtime.server.close().catch(() => {});
    await disposeCapturedMiniflareRuntimes(runtime.capturedDevEnvs as any).catch(() => {});
    rmSync(runtime.storageRoot, { force: true, recursive: true });
  };

  const runtime = await startRuntime();
  const waiters: Array<(index: number) => void> = [];

  const acquireSlot = (): Promise<Slot> => {
    const index = runtime.freeSlots.shift();
    if (index !== undefined) return Promise.resolve({ index, runtime });
    return new Promise((resolve) => waiters.push((next) => resolve({ index: next, runtime })));
  };

  const releaseSlot = async ({ index }: Slot) => {
    const supervisorName = fencedSlots.slotSupervisorNames[index]!;
    try {
      await retireFencedSlot(runtime.server.getWorker(supervisorName), fencedSlots.secret);
    } catch {
      // Slot may already be retired or shutting down.
    }
    const next = waiters.shift();
    if (next) next(index);
    else runtime.freeSlots.push(index);
  };

  const activeLeases = new Map<string, { clientPid: number; logsFrom: number; slot: Slot }>();
  // Every runtime's logs, numbered in order: a lease reads those written since it began, as a
  // process's own runtime gives its run the logs since it started. Each runtime's own buffer is
  // drained into it, and what no lease can still read is dropped.
  let logs: ReturnType<Runtime["server"]["getLogs"]> = [];
  let logsBase = 0;
  const drainLogs = () => {
    const fresh = runtime.server.getLogs();
    if (fresh.length) {
      runtime.server.clearLogs();
      logs.push(...fresh);
    }
    const oldest = Math.min(logsBase + logs.length, ...[...activeLeases.values()].map((lease) => lease.logsFrom));
    if (oldest > logsBase) {
      logs = logs.slice(oldest - logsBase);
      logsBase = oldest;
    }
  };
  let runCounter = 0;
  let shuttingDown = false;

  const httpServer = http.createServer(async (req, res) => {
    const urlPath = req.url ?? "/";
    if (!urlPath.startsWith("/__btcf_broker/")) {
      sendJson(res, 404, { error: "Not found" });
      return;
    }
    if (req.headers["x-btcf-broker-token"] !== config.token) {
      sendJson(res, 403, { error: "Forbidden" });
      return;
    }
    try {
      if (req.method === "GET" && urlPath === "/__btcf_broker/health") {
        sendJson(res, 200, {
          activeLeases: activeLeases.size,
          // Who holds each lease, for finding a test process that holds its slot.
          leases: [...activeLeases.values()].map(({ clientPid, slot }) => ({ clientPid, slot: slot.index })),
          freeSlots: runtime.freeSlots.length,
          ok: true,
          slotCount: config.slotCount,
        });
        return;
      }
      if (req.method === "POST" && urlPath === "/__btcf_broker/lease") {
        const body = (await readJsonBody(req)) as {
          clientPid?: number;
          runtimeVarsByWorker?: Record<string, Record<string, unknown>>;
          settings?: FencedRunSettings;
        };
        const slot = await acquireSlot();
        const { index } = slot;
        const supervisorName = fencedSlots.slotSupervisorNames[index]!;
        const runId = `run-${++runCounter}`;
        const leaseId = crypto.randomUUID();
        try {
          await activateFencedSlot(
            runtime.server.getWorker(supervisorName),
            fencedSlots.secret,
            runId,
            body.runtimeVarsByWorker,
            body.settings,
          );
        } catch (error) {
          await releaseSlot(slot);
          throw error;
        }
        drainLogs();
        activeLeases.set(leaseId, {
          clientPid: Number(body.clientPid) || 0,
          logsFrom: logsBase + logs.length,
          slot,
        });
        sendJson(res, 200, {
          leaseId,
          proxyBindings: runtime.slotProxyBindings[supervisorName],
          proxyUrl: runtime.proxyUrl,
          upgradeUrl: runtime.upgradeUrl,
          runId,
          serviceKey: runtime.slotServiceKeys[supervisorName],
          slotIndex: index,
          slotSupervisorName: supervisorName,
        });
        return;
      }
      if (req.method === "POST" && urlPath === "/__btcf_broker/logs") {
        // The lease's logs from `after` (its own count of those it has), or from now on with `clear`.
        const body = (await readJsonBody(req)) as { after?: number; clear?: boolean; leaseId?: string };
        const lease = body.leaseId ? activeLeases.get(body.leaseId) : undefined;
        if (!lease) {
          sendJson(res, 404, { error: "Unknown lease" });
          return;
        }
        drainLogs();
        if (body.clear) lease.logsFrom = logsBase + logs.length;
        const from = lease.logsFrom + (Number(body.after) || 0);
        sendJson(res, 200, { logs: logs.slice(Math.max(0, from - logsBase)) });
        return;
      }
      if (req.method === "POST" && urlPath === "/__btcf_broker/release") {
        const body = (await readJsonBody(req)) as { leaseId?: string };
        const lease = body.leaseId ? activeLeases.get(body.leaseId) : undefined;
        if (lease && body.leaseId) {
          activeLeases.delete(body.leaseId);
          await releaseSlot(lease.slot);
        }
        sendJson(res, 200, { ok: true });
        return;
      }
      sendJson(res, 404, { error: "Not found" });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
      });
    }
  });
  httpServer.keepAliveTimeout = 0;
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("SharedSlotBrokerDaemon failed to bind TCP address");
  }

  const endpoint: SharedBrokerEndpointInfo = {
    supportsGetExport: "getExport" in runtime.server.getWorker(fencedSlots.slotSupervisorNames[0]),
    fencedSecret: fencedSlots.secret,
    parentPid: config.parentPid,
    pid: process.pid,
    slotCount: config.slotCount,
    token: config.token,
    url: `http://127.0.0.1:${address.port}`,
    workerSpecs: fencedSlots.workerSpecs,
  };
  // The lock is the spawning test process's until now; from here it is this broker's, so a
  // broker that dies without shutting down (killed, or its runtime crashed) leaves a lock whose
  // owner is gone, which the next test process to need a broker reclaims.
  writeFileSync(config.lockPath, `${process.pid}\n`);
  const tmpEndpoint = `${config.endpointPath}.${process.pid}.tmp`;
  writeFileSync(tmpEndpoint, JSON.stringify(endpoint));
  renameSync(tmpEndpoint, config.endpointPath);

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    clearInterval(watchdog);
    try {
      httpServer.close();
    } catch {}
    await closeRuntime(runtime);
    cleanupFencedWorkerSlots(fencedSlots.cleanupDir);
    rmSync(config.endpointPath, { force: true });
    rmSync(config.lockPath, { force: true });
    rmSync(config.configPath, { force: true });
    rmSync(path.join(config.brokerDir, `${config.brokerKey}.workers`), { force: true, recursive: true });
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  const watchdog = setInterval(() => {
    if (!isProcessAlive(config.parentPid)) {
      void shutdown();
      return;
    }
    // Reclaim slots whose client Bun worker process exited unexpectedly.
    for (const [leaseId, lease] of activeLeases) {
      if (lease.clientPid > 0 && !isProcessAlive(lease.clientPid)) {
        activeLeases.delete(leaseId);
        void releaseSlot(lease.slot);
      }
    }
  }, 500);
};

runDaemon().catch((error) => {
  console.error("[bun-test-cloudflare] SharedSlotBrokerDaemon failed:", error);
  process.exit(1);
});
