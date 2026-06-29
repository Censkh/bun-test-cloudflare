import { installGlobalCachesBridge } from "./CacheBridge";
import { installCloudflareWorkersPatch } from "./patches/CloudflareWorkersPatch";
import { installMiniflarePatch } from "./patches/MiniflarePatch";
import { installMiniflareWebGlobalsPatch } from "./patches/MiniflareWebGlobalsPatch";
import { installUndiciPatch } from "./patches/UndiciPatch";
import { installWebStreamPatch } from "./patches/WebStreamPatch";
import { installWebsocketPatch } from "./patches/WebsocketPatch";
import { installWorkerThreadsPatch } from "./patches/WorkerThreadsPatch";
import { installWranglerGuessWorkerFormatPatch } from "./patches/WranglerGuessWorkerFormatPatch";

installWebStreamPatch();
installGlobalCachesBridge();
installUndiciPatch();
installWebsocketPatch();
installMiniflareWebGlobalsPatch();
installWranglerGuessWorkerFormatPatch();
installMiniflarePatch();
installWorkerThreadsPatch();
installCloudflareWorkersPatch();
