import { mock } from "bun:test";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";
import { trackPlatformProxyDispatch } from "../wranglerPatches";

export const installMiniflarePatch = () => {
  if (!shouldInstallCompatibilityPatch("miniflare-platform-proxy-dispatch")) {
    return;
  }

  const miniflare = require("miniflare");
  const OriginalMiniflare = miniflare.Miniflare;

  class BunTestCloudflareMiniflare extends OriginalMiniflare {
    constructor(...args: any[]) {
      super(...args);
      const originalDispatchFetch = this.dispatchFetch.bind(this);
      this.dispatchFetch = (input: unknown, init?: unknown) => {
        return trackPlatformProxyDispatch(input, originalDispatchFetch(input, init));
      };
    }
  }

  mock.module("miniflare", () => ({
    ...miniflare,
    default: {
      ...miniflare,
      Miniflare: BunTestCloudflareMiniflare,
    },
    Miniflare: BunTestCloudflareMiniflare,
  }));
};
