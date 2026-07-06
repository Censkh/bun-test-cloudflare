import http from "node:http";
import { trackBrowserRenderingLaunchRequest } from "./BrowserRenderingPatch";

const isMiniflareInternalLoopbackRequest = (request: http.IncomingMessage) => {
  try {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    return pathname === "/browser/launch";
  } catch {
    return false;
  }
};

export const drainMiniflareLoopbackRequests = async () => {};

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
      if (isMiniflareInternalLoopbackRequest(request)) {
        trackBrowserRenderingLaunchRequest(response);
      }
      return listener(request, response);
    };

    return originalCreateServer.apply(this as any, [...args.slice(0, -1), wrappedListener] as any);
  } as typeof http.createServer;

  Object.defineProperty(http.createServer, "__bunTestCloudflareLoopbackPatched", {
    value: true,
  });
};
