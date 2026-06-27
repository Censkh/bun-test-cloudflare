import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
      configPath: path.join(import.meta.dir, "wrangler.backend.toml"),
      name: "backend-fixture",
    },
    CMS: {
      configPath: path.join(import.meta.dir, "wrangler.cms.toml"),
      name: "cms-fixture",
    },
  },
});

const waitForMessage = (socket: WebSocket) =>
  new Promise<MessageEvent>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("websocket message timed out")), 2_000);
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        resolve(event);
      },
      { once: true },
    );
    socket.addEventListener("error", () => reject(new Error("websocket errored")), { once: true });
  });

describe("createCloudflareHarness", () => {
  test("provides typed workers and service bindings", async () => {
    await harness.run(async (workers) => {
      const backendResponse = await workers.BACKEND.fetch("https://example.com/");
      expect(await backendResponse.text()).toBe("backend-ok");

      const cmsResponse = await workers.BACKEND.fetch("https://example.com/cms");
      expect(await cmsResponse.json()).toEqual({ ok: true, source: "cms" });
    });
  });

  test("runs Durable Object RPC with persistent object state", async () => {
    await harness.run(async (workers) => {
      const firstResponse = await workers.BACKEND.fetch("https://example.com/counter?id=e2e");
      expect(await firstResponse.json()).toEqual({ count: 1 });

      const secondResponse = await workers.BACKEND.fetch("https://example.com/counter?id=e2e");
      expect(await secondResponse.json()).toEqual({ count: 2 });

      const otherObjectResponse = await workers.BACKEND.fetch("https://example.com/counter?id=other");
      expect(await otherObjectResponse.json()).toEqual({ count: 1 });
    });
  });

  test("supports Cloudflare websocket responses under Bun", async () => {
    await harness.run(async (workers) => {
      const subscribeResponse = await workers.BACKEND.fetch("https://example.com/events/subscribe", {
        headers: { Upgrade: "websocket" },
      });
      expect(subscribeResponse.status).toBe(101);
      expect(subscribeResponse.webSocket).toBeDefined();

      const socket = subscribeResponse.webSocket!;
      socket.accept();
      const messagePromise = waitForMessage(socket);

      const publishResponse = await workers.BACKEND.fetch("https://example.com/events/publish?message=hello-fixture");
      expect(await publishResponse.json()).toEqual({ sockets: 1 });
      expect((await messagePromise).data).toBe("hello-fixture");

      socket.close();
    });
  });
});
