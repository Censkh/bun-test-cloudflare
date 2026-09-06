import { semver, spawnSync } from "bun";

// Bun.version and process.versions.bun omit the canary suffix on some builds.
const revision = spawnSync([process.execPath, "--revision"], { timeout: 5_000 });
const runtimeBunVersion = revision.exitCode === 0 ? revision.stdout.toString().trim() : undefined;

export const COMPATABILITY_PATCHES = {
  // Disabled from Bun 1.4.0.
  "web-streams-readable-constructor": { id: "web-streams-readable-constructor", disabledFromVersion: "1.4.0" },
  "web-streams-writable-constructor": { id: "web-streams-writable-constructor", disabledFromVersion: "1.4.0" },
  "web-streams-readable-prototype": { id: "web-streams-readable-prototype", disabledFromVersion: "1.4.0" },
  "web-streams-writable-prototype": { id: "web-streams-writable-prototype", disabledFromVersion: "1.4.0" },
  "global-caches-named": { id: "global-caches-named", disabledFromVersion: "1.4.0" },
  "child-process-extra-fd": { id: "child-process-extra-fd", disabledFromVersion: "1.4.0" },
  "workerd-child-process-unref": { id: "workerd-child-process-unref", disabledFromVersion: "1.4.0" },
  "workerd-child-process-stdio-unref": { id: "workerd-child-process-stdio-unref", disabledFromVersion: "1.4.0" },
  "undici-mark-as-uncloneable": { id: "undici-mark-as-uncloneable", disabledFromVersion: "1.4.0" },
  "undici-commonjs-require": { id: "undici-commonjs-require", disabledFromVersion: "1.4.0" },
  websocket: { id: "websocket", disabledFromVersion: "1.4.0" },
  "miniflare-headers": { id: "miniflare-headers", disabledFromVersion: "1.4.0" },
  "wrangler-guess-worker-format": { id: "wrangler-guess-worker-format", disabledFromVersion: "1.4.0" },
  "miniflare-loopback": { id: "miniflare-loopback", disabledFromVersion: "1.4.0" },
  "miniflare-loopback-launch": { id: "miniflare-loopback-launch", disabledFromVersion: "1.4.0" },
  "miniflare-loopback-close": { id: "miniflare-loopback-close", disabledFromVersion: "1.4.0" },
  miniflare: { id: "miniflare", disabledFromVersion: "1.4.0" },
  "miniflare-platform-proxy-dispatch": { id: "miniflare-platform-proxy-dispatch", disabledFromVersion: "1.4.0" },
  "platform-proxy-response-drain": { id: "platform-proxy-response-drain", disabledFromVersion: "1.4.0" },
  "wrangler-dev-env-runtime-errors": { id: "wrangler-dev-env-runtime-errors", disabledFromVersion: "1.4.0" },
  "wrangler-dev-env-persist": { id: "wrangler-dev-env-persist", disabledFromVersion: "1.4.0" },

  // Disabled from Bun 1.4.2.
  "worker-threads-fifo": { id: "worker-threads-fifo", disabledFromVersion: "1.4.2" },
  "worker-threads-no-timeouts": { id: "worker-threads-no-timeouts", disabledFromVersion: "1.4.2" },

  // No automatic disable version.
  // FormData must remain compatible with the Miniflare Request/Response overrides.
  "miniflare-form-data": { id: "miniflare-form-data", disabledFromVersion: null },
  "web-streams": { id: "web-streams", disabledFromVersion: null },
  "global-caches": { id: "global-caches", disabledFromVersion: null },
  "global-caches-install": { id: "global-caches-install", disabledFromVersion: null },
  "global-caches-default": { id: "global-caches-default", disabledFromVersion: null },
  "workerd-child-process": { id: "workerd-child-process", disabledFromVersion: null },
  "workerd-child-process-stdio-errors": { id: "workerd-child-process-stdio-errors", disabledFromVersion: null },
  "browser-rendering": { id: "browser-rendering", disabledFromVersion: null },
  "browser-rendering-spawn": { id: "browser-rendering-spawn", disabledFromVersion: null },
  undici: { id: "undici", disabledFromVersion: null },
  "undici-esm-module": { id: "undici-esm-module", disabledFromVersion: null },
  "websocket-module": { id: "websocket-module", disabledFromVersion: null },
  "websocket-global": { id: "websocket-global", disabledFromVersion: null },
  "worker-threads": { id: "worker-threads", disabledFromVersion: null },
  "worker-threads-stream-bridge": { id: "worker-threads-stream-bridge", disabledFromVersion: null },
  "miniflare-web-globals": { id: "miniflare-web-globals", disabledFromVersion: null },
  "miniflare-request": { id: "miniflare-request", disabledFromVersion: null },
  "miniflare-response": { id: "miniflare-response", disabledFromVersion: null },
  "cloudflare-workers": { id: "cloudflare-workers", disabledFromVersion: null },
  "cloudflare-workers-durable-object": { id: "cloudflare-workers-durable-object", disabledFromVersion: null },
  "cloudflare-workers-worker-entrypoint": { id: "cloudflare-workers-worker-entrypoint", disabledFromVersion: null },
  "wrangler-dev-env": { id: "wrangler-dev-env", disabledFromVersion: null },
  "wrangler-dev-env-capture": { id: "wrangler-dev-env-capture", disabledFromVersion: null },
  "wrangler-dev-env-force-local": { id: "wrangler-dev-env-force-local", disabledFromVersion: null },
} as const satisfies Record<string, { id: string; disabledFromVersion: string | null }>;

export type CompatibilityPatchName = (typeof COMPATABILITY_PATCHES)[keyof typeof COMPATABILITY_PATCHES]["id"];

export const compatibilityPatchNames = Object.values(COMPATABILITY_PATCHES).map((patch) => patch.id);

type PatchEnvironment = {
  BUN_TEST_CLOUDFLARE_DISABLED_PATCHES?: string;
};

// Standard ranges exclude prereleases and reject invalid versions.
export const isBunVersionAtLeast = (version: string | undefined, minimum: string) =>
  version !== undefined && semver.satisfies(version, `>=${minimum}`);

const parsePatchNames = (value: string | undefined) =>
  new Set(
    (value ?? "")
      .split(",")
      .map((patchName) => patchName.trim())
      .filter(Boolean),
  );

const assertKnownPatchNames = (patchNames: Set<string>) => {
  const unknownPatchNames = [...patchNames].filter(
    (patchName): patchName is string => !compatibilityPatchNames.includes(patchName as CompatibilityPatchName),
  );
  if (unknownPatchNames.length > 0) {
    throw new Error(`Unknown bun-test-cloudflare compatibility patch: ${unknownPatchNames.join(", ")}`);
  }
};

export const getDisabledCompatibilityPatches = (
  environment: PatchEnvironment = process.env as PatchEnvironment,
  bunVersion = runtimeBunVersion,
) => {
  const disabledPatchNames = parsePatchNames(environment.BUN_TEST_CLOUDFLARE_DISABLED_PATCHES);
  for (const patch of Object.values(COMPATABILITY_PATCHES)) {
    if (patch.disabledFromVersion !== null && isBunVersionAtLeast(bunVersion, patch.disabledFromVersion)) {
      disabledPatchNames.add(patch.id);
    }
  }
  assertKnownPatchNames(disabledPatchNames);
  return disabledPatchNames as Set<CompatibilityPatchName>;
};

export const shouldInstallCompatibilityPatch = (
  patchName: CompatibilityPatchName,
  environment: PatchEnvironment = process.env as PatchEnvironment,
  bunVersion = runtimeBunVersion,
) => !getDisabledCompatibilityPatches(environment, bunVersion).has(patchName);

export const shouldInstallCompatibilityPatchGroup = (
  patchName: CompatibilityPatchName,
  childPatchNames: readonly CompatibilityPatchName[],
  environment: PatchEnvironment = process.env as PatchEnvironment,
  bunVersion = runtimeBunVersion,
) =>
  shouldInstallCompatibilityPatch(patchName, environment, bunVersion) &&
  childPatchNames.some((childPatchName) => shouldInstallCompatibilityPatch(childPatchName, environment, bunVersion));
