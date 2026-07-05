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
  globalThis.Request = miniflare.Request as unknown as typeof globalThis.Request;
  globalThis.Response = miniflare.Response as unknown as typeof globalThis.Response;
  globalThis.Headers = miniflare.Headers as unknown as typeof globalThis.Headers;
  globalThis.FormData = miniflare.FormData as unknown as typeof globalThis.FormData;
};
