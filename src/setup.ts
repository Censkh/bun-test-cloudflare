import { afterAll } from "bun:test";
import { installGlobalCachesBridge } from "./CacheBridge";
import {
  type CompatibilityPatchName,
  shouldInstallCompatibilityPatch,
  shouldInstallCompatibilityPatchGroup,
} from "./CompatibilityPatches";
import { closePrewarmedServerOrchestrators } from "./PrewarmedServerOrchestrator";
import { installBrowserRenderingPatch } from "./patches/BrowserRenderingPatch";
import { installChildProcessExtraFdPatch } from "./patches/ChildProcessExtraFdPatch";
import { installCloudflareWorkersPatch } from "./patches/CloudflareWorkersPatch";
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
import { installWranglerEsbuildPatch, stopWranglerEsbuildService } from "./patches/WranglerGuessWorkerFormatPatch";
import { installWsCloseHandshakePatch } from "./patches/WsCloseHandshakePatch";

const installCompatibilityPatch = (patchName: CompatibilityPatchName, install: () => void) => {
  if (shouldInstallCompatibilityPatch(patchName)) {
    install();
  }
};

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
installCompatibilityPatch("global-caches", installGlobalCachesBridge);
// Miniflare loads `ws` when the patches below require it. The websocket patch replaces `ws` itself.
if (!shouldInstallCompatibilityPatch("websocket")) {
  installCompatibilityPatch("ws-close-handshake", installWsCloseHandshakePatch);
}
installCompatibilityPatch("child-process-extra-fd", installChildProcessExtraFdPatch);
installWorkerdChildProcessPatch();
if (shouldInstallCompatibilityPatchGroup("browser-rendering", ["browser-rendering-spawn"])) {
  installBrowserRenderingPatch();
}
installCompatibilityPatch("undici", installUndiciPatch);
installCompatibilityPatch("websocket", installWebsocketPatch);
installCompatibilityPatch("worker-threads", installWorkerThreadsPatch);
// Loads Miniflare, so it must follow the undici and ws mocks above and precede every patch below.
installMiniflareSourcePatch({
  capnpArenaGrowth: shouldInstallCompatibilityPatch("miniflare-capnp-arena-growth"),
  proxyCallRetention: shouldInstallCompatibilityPatch("miniflare-proxy-call-retention"),
});
installCompatibilityPatch("miniflare-web-globals", installMiniflareWebGlobalsPatch);
installWranglerEsbuildPatch({
  cacheGuessWorkerFormat: shouldInstallCompatibilityPatch("wrangler-guess-worker-format"),
  restartStoppedService: shouldInstallCompatibilityPatch("esbuild-service-restart"),
});
if (
  shouldInstallCompatibilityPatchGroup("miniflare-loopback", [
    "miniflare-loopback-launch",
    "miniflare-loopback-close",
  ]) ||
  shouldInstallCompatibilityPatchGroup("browser-rendering", ["browser-rendering-spawn"])
) {
  installMiniflareLoopbackPatch();
}
if (shouldInstallCompatibilityPatchGroup("miniflare", ["miniflare-platform-proxy-dispatch"])) {
  installMiniflarePatch();
}
if (
  shouldInstallCompatibilityPatchGroup("cloudflare-workers", [
    "cloudflare-workers-durable-object",
    "cloudflare-workers-worker-entrypoint",
  ])
) {
  installCloudflareWorkersPatch();
}
// Loads Wrangler, so it must follow every module mock above.
if (shouldInstallCompatibilityPatch("undici")) {
  installCompatibilityPatch("wrangler-bun-detection", installWranglerBunDetectionPatch);
}

afterAll(async () => {
  try {
    await closePrewarmedServerOrchestrators();
  } finally {
    stopWranglerEsbuildService();
  }
});
