import http from "node:http";

const pendingLoopbackRequests = new Set<Promise<void>>();

const isMiniflareInternalLoopbackRequest = (request: http.IncomingMessage) => {
  try {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname;
    return pathname === "/browser/launch";
  } catch {
    return false;
  }
};

const trackRequest = (result: unknown) => {
  const request = Promise.resolve(result).then(() => undefined);
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
  http.createServer = function bunTestCloudflareCreateServer(...args: any[]) {
    const listener = args[args.length - 1];
    if (typeof listener !== "function") {
      return originalCreateServer.apply(this, args as any);
    }

    const wrappedListener: typeof listener = (request, response) => {
      const result = listener(request, response);
      if (isMiniflareInternalLoopbackRequest(request)) {
        trackRequest(result);
      }
      return result;
    };

    return originalCreateServer.apply(this, [...args.slice(0, -1), wrappedListener] as any);
  } as typeof http.createServer;

  Object.defineProperty(http.createServer, "__bunTestCloudflareLoopbackPatched", {
    value: true,
  });
};
