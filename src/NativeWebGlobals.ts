// Bun's own Web API classes, captured before `installMiniflareWebGlobalsPatch` replaces the
// globals with Miniflare's. `Bun.serve` only accepts native Response objects.
export const NativeResponse = globalThis.Response;
export const NativeHeaders = globalThis.Headers;
