import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";

export const installMiniflareWebGlobalsPatch = () => {
  const path = require("node:path") as typeof import("node:path");
  const wranglerPackageJsonPath = require.resolve("wrangler/package.json");
  const wranglerMiniflarePath = require.resolve("miniflare", {
    paths: [path.dirname(wranglerPackageJsonPath)],
  });
  const miniflare = require(wranglerMiniflarePath) as typeof import("miniflare");

  // Miniflare's platform-proxy serializer only recognises its own Undici-backed
  // Web API classes. Bun's native Request/Response objects fail when passed
  // through bindings like caches.default, so host-side test code needs to
  // construct the same classes that Wrangler's bundled Miniflare expects.
  if (shouldInstallCompatibilityPatch("miniflare-request")) {
    globalThis.Request = miniflare.Request as unknown as typeof globalThis.Request;
  }
  if (shouldInstallCompatibilityPatch("miniflare-response")) {
    globalThis.Response = miniflare.Response as unknown as typeof globalThis.Response;
  }
  if (shouldInstallCompatibilityPatch("miniflare-headers")) {
    globalThis.Headers = miniflare.Headers as unknown as typeof globalThis.Headers;
  }
  if (shouldInstallCompatibilityPatch("miniflare-form-data")) {
    globalThis.FormData = miniflare.FormData as unknown as typeof globalThis.FormData;
  }
};
