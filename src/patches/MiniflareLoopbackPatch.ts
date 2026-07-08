import http from "node:http";
import { trackBrowserRenderingLaunchRequest } from "./BrowserRenderingPatch";

const pendingLoopbackRequests = new Set<Promise<void>>();

const getMiniflareInternalLoopbackPathname = (request: http.IncomingMessage) => {
  try {
    return new URL(request.url ?? "", "http://localhost").pathname;
  } catch {
    return undefined;
  }
};

const trackLoopbackResponse = (response: http.ServerResponse) => {
  let settled = false;
  let settle!: () => void;
  const request = new Promise<void>((resolve) => {
    settle = () => {
      if (settled) return;
      settled = true;
      response.off("close", settle);
      response.off("finish", settle);
      resolve();
    };

    response.once("close", settle);
    response.once("finish", settle);
  });

  pendingLoopbackRequests.add(request);
  request.finally(() => pendingLoopbackRequests.delete(request)).catch(() => {});
};

export const drainMiniflareLoopbackRequests = async () => {
  while (pendingLoopbackRequests.size > 0) {
    await Promise.allSettled([...pendingLoopbackRequests]);
  }
};

export const installMiniflareLoopbackPatch = () => {
  if ((http.createServer as any).__bunTestCloudflareLoopbackPatched) {
    return;
  }

  const originalCreateServer = http.createServer;
  http.createServer = function bunTestCloudflareCreateServer(this: unknown, ...args: any[]) {
    const listener = args[args.length - 1];
    if (typeof listener !== "function") {
      return originalCreateServer.apply(this as any, args as any);
    }

    const wrappedListener: typeof listener = (request: http.IncomingMessage, response: http.ServerResponse) => {
      const pathname = getMiniflareInternalLoopbackPathname(request);
      if (pathname === "/browser/launch") {
        trackBrowserRenderingLaunchRequest(response);
      } else if (pathname === "/browser/close") {
        // Miniflare's Browser Rendering binding fires this loopback fetch without
        // awaiting it. Draining the response avoids closing the harness while
        // Miniflare still has the browser session registered.
        trackLoopbackResponse(response);
      }
      return listener(request, response);
    };

    return originalCreateServer.apply(this as any, [...args.slice(0, -1), wrappedListener] as any);
  } as typeof http.createServer;

  Object.defineProperty(http.createServer, "__bunTestCloudflareLoopbackPatched", {
    value: true,
  });
};
