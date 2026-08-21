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
import { installMiniflareWebGlobalsPatch } from "./patches/MiniflareWebGlobalsPatch";
import { installUndiciPatch } from "./patches/UndiciPatch";
import { installWebStreamPatch } from "./patches/WebStreamPatch";
import { installWebsocketPatch } from "./patches/WebsocketPatch";
import { installWorkerdChildProcessPatch } from "./patches/WorkerdChildProcessPatch";
import { installWorkerThreadsPatch } from "./patches/WorkerThreadsPatch";
import {
  installWranglerGuessWorkerFormatPatch,
  stopWranglerEsbuildService,
} from "./patches/WranglerGuessWorkerFormatPatch";

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
installCompatibilityPatch("child-process-extra-fd", installChildProcessExtraFdPatch);
if (
  shouldInstallCompatibilityPatchGroup("workerd-child-process", [
    "workerd-child-process-unref",
    "workerd-child-process-stdio-unref",
  ])
) {
  installWorkerdChildProcessPatch();
}
if (shouldInstallCompatibilityPatchGroup("browser-rendering", ["browser-rendering-spawn"])) {
  installBrowserRenderingPatch();
}
installCompatibilityPatch("undici", installUndiciPatch);
installCompatibilityPatch("websocket", installWebsocketPatch);
installCompatibilityPatch("worker-threads", installWorkerThreadsPatch);
installCompatibilityPatch("miniflare-web-globals", installMiniflareWebGlobalsPatch);
installCompatibilityPatch("wrangler-guess-worker-format", installWranglerGuessWorkerFormatPatch);
if (
  shouldInstallCompatibilityPatchGroup("miniflare-loopback", ["miniflare-loopback-launch", "miniflare-loopback-close"])
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

afterAll(async () => {
  try {
    await closePrewarmedServerOrchestrators();
  } finally {
    stopWranglerEsbuildService();
  }
});
