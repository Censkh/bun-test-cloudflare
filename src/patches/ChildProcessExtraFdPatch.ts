import net from "node:net";
import { Readable } from "node:stream";

const isChildProcessExtraFdConnect = () => new Error().stack?.includes("node:child_process") ?? false;

export const installChildProcessExtraFdPatch = () => {
  if (!process.versions.bun || (net.connect as any).__bunTestCloudflareExtraFdPatched) {
    return;
  }

  const originalConnect = net.connect;

  net.connect = function bunTestCloudflareConnect(...args: any[]) {
    const options = args[0];

    // Bun's node:child_process wraps stdio fds >= 3 with net.connect({ fd }).
    // That attach is asynchronous, unlike Node's already-open child.stdio[n]
    // streams, so fast control-pipe writers like workerd can hit EPIPE before
    // the parent has connected. Build the readable side directly from the fd.
    if (
      process.versions.bun &&
      isChildProcessExtraFdConnect() &&
      options &&
      typeof options === "object" &&
      typeof options.fd === "number"
    ) {
      return Readable.fromWeb(Bun.file(options.fd).stream() as ReadableStream);
    }

    return originalConnect.apply(this, args as any);
  } as typeof net.connect;

  Object.defineProperty(net.connect, "__bunTestCloudflareExtraFdPatched", {
    value: true,
  });
};
