import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness, getCloudflareHarnessRunContext } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
      configPath: path.join(import.meta.dir, "wrangler.toml"),
      name: "harness-serve-fixture",
    },
  },
});

describe("harness.serve", () => {
  test("forwards requests to the worker and returns native responses", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    try {
      expect(server.url.hostname).toBe("127.0.0.1");
      expect(server.port).toBeGreaterThan(0);

      const echo = await fetch(new URL("/echo?x=1", server.url), {
        method: "POST",
        headers: { "x-test": "header-value" },
        body: "posted-body",
      });
      expect(echo.status).toBe(200);
      expect(await echo.json()).toEqual({
        method: "POST",
        url: `${server.url.origin}/echo?x=1`,
        header: "header-value",
        body: "posted-body",
      });

      const notFound = await fetch(new URL("/missing", server.url));
      expect(notFound.status).toBe(404);

      const noContent = await fetch(new URL("/no-content", server.url));
      expect(noContent.status).toBe(204);
    } finally {
      await server.stop();
    }
  });

  test("keeps every Set-Cookie header and drops Miniflare's internal headers", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    try {
      const response = await fetch(new URL("/cookies", server.url));
      expect(response.headers.getSetCookie()).toEqual(["first=1; Path=/", "second=2; Path=/; HttpOnly"]);
      expect([...response.headers.keys()].filter((name) => name.startsWith("mf-"))).toEqual([]);
    } finally {
      await server.stop();
    }
  });

  test("passes redirects and their cookies through without following them", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    try {
      const response = await fetch(new URL("/redirect", server.url), { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/landed");
      expect(response.headers.getSetCookie()).toEqual(["redirected=1; Path=/"]);
    } finally {
      await server.stop();
    }
  });

  test("passes streamed response bodies through intact", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    try {
      const response = await fetch(new URL("/stream", server.url));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain");
      expect(await response.text()).toBe("first;second");
    } finally {
      await server.stop();
    }
  });

  test("routes handled by the fetch hook run in the harness run context", async () => {
    const server = await harness.serve({
      worker: "BACKEND",
      fetch: async (request, { workers }) => {
        const url = new URL(request.url);
        if (url.pathname === "/__seed") {
          const env = await workers.BACKEND.getEnv();
          await env.KV.put("greeting", "hello");
          // Handlers still see the active run
          const context = getCloudflareHarnessRunContext();
          return Response.json({ sameWorkers: context.workers === workers });
        }
      },
    });
    try {
      const seeded = await fetch(new URL("/__seed", server.url), { method: "POST" });
      expect(await seeded.json()).toEqual({ sameWorkers: true });

      // Unhandled requests fall through to the worker, which sees the seeded data
      const read = await fetch(new URL("/kv?key=greeting", server.url));
      expect(await read.text()).toBe("hello");
    } finally {
      await server.stop();
    }
  });

  test("an error in the fetch hook becomes a 500 and the server keeps serving", async () => {
    const server = await harness.serve({
      worker: "BACKEND",
      fetch: (request) => {
        if (new URL(request.url).pathname === "/__boom") {
          throw new Error("hook failed");
        }
      },
    });
    try {
      const failed = await fetch(new URL("/__boom", server.url));
      expect(failed.status).toBe(500);
      expect(await failed.text()).toContain("hook failed");

      const next = await fetch(new URL("/echo", server.url));
      expect(next.status).toBe(200);
    } finally {
      await server.stop();
    }
  });

  test("proxies WebSocket connections both ways", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    try {
      const socket = new WebSocket(`ws://${server.url.host}/ws`);
      const messages: string[] = [];
      const closed = new Promise<CloseEvent>((resolve) => {
        socket.addEventListener("close", resolve);
      });
      socket.addEventListener("message", (event) => {
        messages.push(String(event.data));
      });
      const received = async (count: number) => {
        const deadline = Date.now() + 5_000;
        while (messages.length < count) {
          if (Date.now() > deadline) throw new Error(`Only received: ${messages.join(", ")}`);
          await Bun.sleep(10);
        }
      };

      // The worker's greeting is sent before the client connection finishes opening
      await received(1);
      socket.send("ping");
      await received(2);
      expect(messages).toEqual(["hello", "echo:ping"]);

      socket.send("close");
      const event = await closed;
      expect(event.code).toBe(4000);
      expect(event.reason).toBe("closed by worker");
    } finally {
      await server.stop();
    }
  });

  test("stop() closes the port and ends the run", async () => {
    const server = await harness.serve({ worker: "BACKEND" });
    const { url } = server;
    await server.stop();
    await server.stopped;
    await expect(fetch(url)).rejects.toThrow();
  });

  test("rejects when asked to serve an unknown worker", async () => {
    await expect(harness.serve({ worker: "MISSING" as "BACKEND" })).rejects.toThrow(
      'Cannot serve unknown worker "MISSING"',
    );
  });

  test("serveHarnessUntilExit serves until SIGTERM and then exits cleanly", async () => {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "./serveUntilExit.entry.ts"],
      cwd: import.meta.dir,
      env: { ...process.env, SERVE_UNTIL_EXIT_PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });

    // Wait for the "serving ... at <origin>" line
    const decoder = new TextDecoder();
    let output = "";
    let origin: string | undefined;
    const readers = [child.stdout.getReader(), child.stderr.getReader()];
    const deadline = Date.now() + 60_000;
    while (!origin && Date.now() < deadline) {
      const chunk = await Promise.race(readers.map((reader) => reader.read()));
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
      origin = output.match(/serving BACKEND at (http:\/\/\S+)/)?.[1];
    }
    expect(origin, output).toBeDefined();

    const response = await fetch(`${origin}/kv?key=ready`);
    expect(await response.text()).toBe("yes");

    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  }, 90_000);
});
