import { afterAll } from "bun:test";
import { installGlobalCachesBridge } from "./CacheBridge";
import { type CompatibilityPatchName, shouldInstallCompatibilityPatch } from "./CompatibilityPatches";
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
import { installWranglerGuessWorkerFormatPatch } from "./patches/WranglerGuessWorkerFormatPatch";

const installCompatibilityPatch = (patchName: CompatibilityPatchName, install: () => void) => {
  if (shouldInstallCompatibilityPatch(patchName)) {
    install();
  }
};

installCompatibilityPatch("web-streams", installWebStreamPatch);
installCompatibilityPatch("global-caches", installGlobalCachesBridge);
installCompatibilityPatch("child-process-extra-fd", installChildProcessExtraFdPatch);
installCompatibilityPatch("workerd-child-process", installWorkerdChildProcessPatch);
installCompatibilityPatch("browser-rendering", installBrowserRenderingPatch);
installCompatibilityPatch("undici", installUndiciPatch);
installCompatibilityPatch("websocket", installWebsocketPatch);
installCompatibilityPatch("worker-threads", installWorkerThreadsPatch);
installCompatibilityPatch("miniflare-web-globals", installMiniflareWebGlobalsPatch);
installCompatibilityPatch("wrangler-guess-worker-format", installWranglerGuessWorkerFormatPatch);
installCompatibilityPatch("miniflare-loopback", installMiniflareLoopbackPatch);
installCompatibilityPatch("miniflare", installMiniflarePatch);
installCompatibilityPatch("cloudflare-workers", installCloudflareWorkersPatch);

afterAll(async () => {
  await closePrewarmedServerOrchestrators();
});
