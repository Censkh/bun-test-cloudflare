import { afterAll } from "bun:test";
import { installGlobalCachesBridge } from "./CacheBridge";
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
import { installWorkerdProcessPatch } from "./patches/WorkerdProcessPatch";
import { installWorkerThreadsPatch } from "./patches/WorkerThreadsPatch";
import { installWranglerGuessWorkerFormatPatch } from "./patches/WranglerGuessWorkerFormatPatch";

installWebStreamPatch();
installGlobalCachesBridge();
installChildProcessExtraFdPatch();
installBrowserRenderingPatch();
installUndiciPatch();
installWebsocketPatch();
installWorkerThreadsPatch();
installWorkerdProcessPatch();
installMiniflareWebGlobalsPatch();
installWranglerGuessWorkerFormatPatch();
installMiniflareLoopbackPatch();
installMiniflarePatch();
installCloudflareWorkersPatch();

afterAll(async () => {
  await closePrewarmedServerOrchestrators();
});
