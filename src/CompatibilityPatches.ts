export const compatibilityPatchNames = [
  "web-streams",
  "web-streams-readable-constructor",
  "web-streams-writable-constructor",
  "web-streams-readable-prototype",
  "web-streams-writable-prototype",
  "global-caches",
  "global-caches-install",
  "global-caches-default",
  "global-caches-named",
  "child-process-extra-fd",
  "workerd-child-process",
  "workerd-child-process-unref",
  "workerd-child-process-stdio-unref",
  "browser-rendering",
  "browser-rendering-spawn",
  "undici",
  "undici-mark-as-uncloneable",
  "undici-commonjs-require",
  "undici-esm-module",
  "websocket",
  "websocket-module",
  "websocket-global",
  "worker-threads",
  "worker-threads-fifo",
  "worker-threads-stream-bridge",
  "worker-threads-no-timeouts",
  "miniflare-web-globals",
  "miniflare-request",
  "miniflare-response",
  "miniflare-headers",
  "miniflare-form-data",
  "wrangler-guess-worker-format",
  "miniflare-loopback",
  "miniflare-loopback-launch",
  "miniflare-loopback-close",
  "miniflare",
  "miniflare-platform-proxy-dispatch",
  "platform-proxy-response-drain",
  "cloudflare-workers",
  "cloudflare-workers-durable-object",
  "cloudflare-workers-worker-entrypoint",
  "wrangler-dev-env",
  "wrangler-dev-env-runtime-errors",
  "wrangler-dev-env-capture",
  "wrangler-dev-env-force-local",
  "wrangler-dev-env-persist",
] as const;

export type CompatibilityPatchName = (typeof compatibilityPatchNames)[number];

type BunVersion = {
  major: number;
  minor: number;
  patch: number;
};

type PatchEnvironment = {
  BUN_TEST_CLOUDFLARE_BUN_1_4_DISABLED_PATCHES?: string;
  BUN_TEST_CLOUDFLARE_DISABLED_PATCHES?: string;
};

const bun14: BunVersion = { major: 1, minor: 4, patch: 0 };

const bun14DisabledCompatibilityPatches = new Set<CompatibilityPatchName>([
  "web-streams-readable-constructor",
  "web-streams-writable-constructor",
  "web-streams-readable-prototype",
  "web-streams-writable-prototype",
  "child-process-extra-fd",
  "workerd-child-process-unref",
  "workerd-child-process-stdio-unref",
  "undici-mark-as-uncloneable",
  "undici-commonjs-require",
  "miniflare-headers",
  "wrangler-guess-worker-format",
  "miniflare-loopback",
  "miniflare-loopback-launch",
  "miniflare-loopback-close",
  "miniflare",
  "miniflare-platform-proxy-dispatch",
  "platform-proxy-response-drain",
  "global-caches-named",
  "websocket",
  "wrangler-dev-env-runtime-errors",
  "wrangler-dev-env-persist",
]);

const parseBunVersion = (version: string | undefined): BunVersion | undefined => {
  const match = version?.match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
};

export const isBunVersionAtLeast = (version: string | undefined, minimum: BunVersion) => {
  const parsedVersion = parseBunVersion(version);
  if (!parsedVersion) {
    return false;
  }

  if (parsedVersion.major !== minimum.major) {
    return parsedVersion.major > minimum.major;
  }
  if (parsedVersion.minor !== minimum.minor) {
    return parsedVersion.minor > minimum.minor;
  }
  return parsedVersion.patch >= minimum.patch;
};

export const isBun14OrLater = (version = process.versions.bun) => isBunVersionAtLeast(version, bun14);

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
  bunVersion = process.versions.bun,
) => {
  const disabledPatchNames = parsePatchNames(environment.BUN_TEST_CLOUDFLARE_DISABLED_PATCHES);
  if (isBun14OrLater(bunVersion)) {
    for (const patchName of bun14DisabledCompatibilityPatches) {
      disabledPatchNames.add(patchName);
    }
    for (const patchName of parsePatchNames(environment.BUN_TEST_CLOUDFLARE_BUN_1_4_DISABLED_PATCHES)) {
      disabledPatchNames.add(patchName);
    }
  }
  assertKnownPatchNames(disabledPatchNames);
  return disabledPatchNames as Set<CompatibilityPatchName>;
};

export const shouldInstallCompatibilityPatch = (
  patchName: CompatibilityPatchName,
  environment: PatchEnvironment = process.env as PatchEnvironment,
  bunVersion = process.versions.bun,
) => !getDisabledCompatibilityPatches(environment, bunVersion).has(patchName);

export const shouldInstallCompatibilityPatchGroup = (
  patchName: CompatibilityPatchName,
  childPatchNames: readonly CompatibilityPatchName[],
  environment: PatchEnvironment = process.env as PatchEnvironment,
  bunVersion = process.versions.bun,
) =>
  shouldInstallCompatibilityPatch(patchName, environment, bunVersion) &&
  childPatchNames.some((childPatchName) => shouldInstallCompatibilityPatch(childPatchName, environment, bunVersion));
