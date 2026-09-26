import { test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ServerWebSocket } from "bun";
import type { TestHarness, WorkerHandle } from "wrangler";
import type { CloudflareHarness, CloudflareWorkerConfig, CloudflareWorkerMap } from "./harness";
import { NativeHeaders, NativeResponse } from "./NativeWebGlobals";

export type CloudflareHarnessServeContext<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  workers: CloudflareWorkerMap<TWorkers>;
  server: TestHarness;
};

export type CloudflareHarnessServeOptions<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  /** The worker that requests are forwarded to. */
  worker: keyof TWorkers & string;
  /** Defaults to 0, which picks a free port. */
  port?: number;
  /** Defaults to 127.0.0.1. */
  hostname?: string;
  /**
   * Handles a request before it is forwarded, for test-only routes such as seeding data.
   * Return nothing to forward the request to the worker.
   */
  fetch?: (
    request: Request,
    context: CloudflareHarnessServeContext<TWorkers>,
  ) => Response | undefined | void | Promise<Response | undefined | void>;
};

export type CloudflareHarnessServer<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  url: URL;
  port: number;
  workers: CloudflareWorkerMap<TWorkers>;
  /** Stops listening and ends the harness run, releasing its workers. */
  stop(): Promise<void>;
  /** Settles once the server has stopped and the run has ended. */
  stopped: Promise<void>;
};

type ResponseLike = {
  status: number;
  statusText: string;
  headers: Iterable<[string, string]> & { getSetCookie?(): string[] };
  body: ReadableStream<Uint8Array> | null;
  arrayBuffer(): Promise<ArrayBuffer>;
};

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

// Worker responses use Miniflare's Response class, which Bun.serve rejects; rebuild them as native
// ones. Set-Cookie is copied value by value so multiple cookies survive, and Miniflare's internal
// MF-* headers are dropped.
export const toNativeResponse = async (response: ResponseLike): Promise<Response> => {
  if (response instanceof NativeResponse) {
    return response;
  }

  const headers = new NativeHeaders();
  for (const [name, value] of response.headers) {
    const lowerName = name.toLowerCase();
    if (lowerName === "set-cookie" || lowerName.startsWith("mf-")) continue;
    headers.append(name, value);
  }
  for (const cookie of response.headers.getSetCookie?.() ?? []) {
    headers.append("set-cookie", cookie);
  }

  let body: ReadableStream<Uint8Array> | ArrayBuffer | null = null;
  if (!NULL_BODY_STATUSES.has(response.status)) {
    // Stream when the body is a stream Bun can read directly; otherwise buffer it
    body = response.body instanceof ReadableStream ? response.body : await response.arrayBuffer();
  }

  return new NativeResponse(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const forwardToWorker = async (worker: Pick<WorkerHandle, "fetch">, request: Request) => {
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return (await worker.fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: hasBody ? await request.arrayBuffer() : undefined,
    // Surface redirects (and the cookies set on them) to the client as-is
    redirect: "manual",
  })) as unknown as ResponseLike;
};

// The parts of Miniflare's WebSocket used to bridge an upgraded connection
type WorkerWebSocket = {
  accept(): void;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "message", listener: (event: { data: string | ArrayBuffer }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number; reason: string }) => void): void;
};

type BridgedSocketData = {
  upstream: WorkerWebSocket;
  // Messages the worker sent before the client side of the connection opened
  pending: Array<string | ArrayBuffer>;
  open: boolean;
};

// 1005 and 1006 describe a close without a status; they cannot be sent in a close frame
const toSendableCloseCode = (code: number) => (code === 1005 || code === 1006 ? 1000 : code);

const isWebSocketUpgrade = (request: Request) => request.headers.get("upgrade")?.toLowerCase() === "websocket";

export const serveHarness = <const TWorkers extends Record<string, CloudflareWorkerConfig>>(
  harness: Pick<CloudflareHarness<TWorkers>, "run">,
  options: CloudflareHarnessServeOptions<TWorkers>,
): Promise<CloudflareHarnessServer<TWorkers>> => {
  let stopRun: () => void = () => {};
  const stopRequested = new Promise<void>((resolve) => {
    stopRun = resolve;
  });

  return new Promise((resolveReady, rejectReady) => {
    let ready = false;

    const runPromise = harness.run(async (workers, server) => {
      const target = workers[options.worker] as Pick<WorkerHandle, "fetch"> | undefined;
      if (!target) {
        throw new Error(`Cannot serve unknown worker "${options.worker}"`);
      }

      // Request handlers run outside the harness run's async context; restore it so code in
      // `options.fetch` can still use getCloudflareHarnessRunContext()
      const withRunContext = AsyncLocalStorage.snapshot();
      const context = { workers, server };
      const sockets = new Map<BridgedSocketData, ServerWebSocket<BridgedSocketData>>();

      const bunServer = Bun.serve<BridgedSocketData>({
        port: options.port ?? 0,
        hostname: options.hostname ?? "127.0.0.1",
        // A failing request must not end the run that keeps the server alive
        error: (error) =>
          new NativeResponse(error?.stack ?? String(error), {
            status: 500,
            headers: { "Content-Type": "text/plain; charset=utf-8" },
          }),
        fetch: (request, server) =>
          withRunContext(async () => {
            const handled = await options.fetch?.(request, context);
            if (handled) {
              return toNativeResponse(handled as unknown as ResponseLike);
            }

            if (isWebSocketUpgrade(request)) {
              // Open the socket on the worker first, then bridge it to the client's connection
              const response = (await target.fetch(request.url, {
                headers: request.headers,
              })) as unknown as ResponseLike & { webSocket?: WorkerWebSocket | null };
              const upstream = response.webSocket;
              if (response.status !== 101 || !upstream) {
                return toNativeResponse(response);
              }

              const data: BridgedSocketData = { upstream, pending: [], open: false };
              // Listen before accepting: Miniflare delivers messages queued before accept() during it
              upstream.addEventListener("message", (event) => {
                if (data.open) sockets.get(data)?.send(event.data);
                else data.pending.push(event.data);
              });
              upstream.addEventListener("close", (event) => {
                sockets.get(data)?.close(toSendableCloseCode(event.code), event.reason);
              });
              upstream.accept();

              if (server.upgrade(request, { data })) {
                return undefined;
              }
              upstream.close(1011, "Upgrade failed");
              return new NativeResponse("WebSocket upgrade failed", { status: 500 });
            }

            return toNativeResponse(await forwardToWorker(target, request));
          }),
        websocket: {
          open: (socket) => {
            sockets.set(socket.data, socket);
            socket.data.open = true;
            for (const message of socket.data.pending.splice(0)) socket.send(message);
          },
          message: (socket, message) => {
            socket.data.upstream.send(message);
          },
          close: (socket, code, reason) => {
            sockets.delete(socket.data);
            try {
              socket.data.upstream.close(toSendableCloseCode(code), reason);
            } catch {
              // Already closed by the worker
            }
          },
        },
      });

      const url = new URL(`http://${bunServer.hostname}:${bunServer.port}`);
      ready = true;
      resolveReady({
        url,
        port: bunServer.port ?? Number(url.port),
        workers,
        stop: async () => {
          stopRun();
          await runPromise;
        },
        stopped: runPromise.then(() => undefined),
      });

      try {
        await stopRequested;
      } finally {
        await bunServer.stop(true);
      }
    });

    runPromise.catch((error) => {
      if (!ready) rejectReady(error);
    });
  });
};

type ExitSignal = "SIGINT" | "SIGTERM";
const EXIT_SIGNALS: ExitSignal[] = ["SIGINT", "SIGTERM"];

// How long a graceful stop may take after a signal before the original handlers run
const GRACEFUL_STOP_TIMEOUT_MS = 10_000;

/**
 * Stops on the first SIGINT/SIGTERM instead of letting existing handlers exit the process.
 * Miniflare's exit hook calls `process.exit()` on these signals, which would skip ending the
 * harness run. The original handlers are restored afterwards, and are called directly on a
 * second signal or if stopping takes too long, so the process can always be killed.
 */
const handleExitSignalsGracefully = (stop: () => Promise<void>) => {
  const originalListeners = new Map(
    EXIT_SIGNALS.map((signal) => [signal, process.listeners(signal) as Array<(signal: ExitSignal) => void>]),
  );
  for (const signal of EXIT_SIGNALS) {
    process.removeAllListeners(signal);
  }

  const restore = () => {
    for (const signal of EXIT_SIGNALS) {
      process.removeListener(signal, onSignal);
      for (const listener of originalListeners.get(signal) ?? []) {
        if (!process.listeners(signal).includes(listener)) process.on(signal, listener);
      }
    }
  };
  const forceExit = (signal: ExitSignal) => {
    restore();
    for (const listener of originalListeners.get(signal) ?? []) listener(signal);
    // Nothing else handled it: fall back to the default behaviour for the signal
    process.kill(process.pid, signal);
  };

  let stopping = false;
  let stopped!: () => void;
  const received = new Promise<void>((resolve) => {
    stopped = resolve;
  });

  function onSignal(signal: ExitSignal) {
    if (stopping) {
      forceExit(signal);
      return;
    }
    stopping = true;
    const timeout = setTimeout(() => forceExit(signal), GRACEFUL_STOP_TIMEOUT_MS);
    timeout.unref?.();
    stop()
      .catch((error) => console.error("[bun-test-cloudflare] failed to stop cleanly", error))
      .finally(() => {
        clearTimeout(timeout);
        restore();
        stopped();
      });
  }

  for (const signal of EXIT_SIGNALS) {
    process.on(signal, onSignal);
  }

  return { received, restore };
};

// Bun treats large timeouts as "never"; this is the largest value timers accept
const NO_TIMEOUT = 2_147_483_647;

/**
 * Registers a Bun test that serves the harness until the process receives SIGINT or SIGTERM,
 * for use as a long-running backend for browser tests (for example Playwright's `webServer`
 * running `bun test ./path/to/this-file.ts`).
 */
export const serveHarnessUntilExit = <const TWorkers extends Record<string, CloudflareWorkerConfig>>(
  harness: Pick<CloudflareHarness<TWorkers>, "run">,
  options: CloudflareHarnessServeOptions<TWorkers> & {
    onReady?: (server: CloudflareHarnessServer<TWorkers>) => void | Promise<void>;
  },
) => {
  const { onReady, ...serveOptions } = options;
  test(
    `serve ${serveOptions.worker}`,
    async () => {
      const server = await serveHarness(harness, serveOptions);
      const signals = handleExitSignalsGracefully(() => server.stop());
      try {
        console.log(`[bun-test-cloudflare] serving ${serveOptions.worker} at ${server.url.origin}`);
        await onReady?.(server);
        await Promise.race([signals.received, server.stopped]);
        await server.stop();
      } finally {
        signals.restore();
      }
    },
    NO_TIMEOUT,
  );
};
