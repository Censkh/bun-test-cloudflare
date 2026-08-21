import { expect, test } from "bun:test";
import {
  getDisabledCompatibilityPatches,
  isBun14OrLater,
  isBunVersionAtLeast,
  shouldInstallCompatibilityPatch,
  shouldInstallCompatibilityPatchGroup,
} from "../src/CompatibilityPatches";

test("recognises Bun 1.4 versions", () => {
  expect(isBun14OrLater("1.3.14")).toBeFalse();
  expect(isBun14OrLater("1.4.0")).toBeTrue();
  expect(isBun14OrLater("1.4.0-canary.1")).toBeTrue();
  expect(isBunVersionAtLeast("2.0.0", { major: 1, minor: 4, patch: 0 })).toBeTrue();
});

test("applies extra Bun 1.4 patch disables only on Bun 1.4 and later", () => {
  const environment = {
    BUN_TEST_CLOUDFLARE_BUN_1_4_DISABLED_PATCHES: "websocket, worker-threads,worker-threads-fifo",
  };

  expect(getDisabledCompatibilityPatches(environment, "1.3.14")).toEqual(new Set());
  expect(shouldInstallCompatibilityPatch("websocket", environment, "1.4.0")).toBeFalse();
  expect(shouldInstallCompatibilityPatch("worker-threads", environment, "1.4.0")).toBeFalse();
  expect(shouldInstallCompatibilityPatch("worker-threads-fifo", environment, "1.4.0")).toBeFalse();
  expect(shouldInstallCompatibilityPatch("websocket", environment, "1.3.14")).toBeTrue();
  expect(shouldInstallCompatibilityPatch("worker-threads", environment, "1.3.14")).toBeTrue();
});

test("keeps the Bun 1.4 audited patch boundary", () => {
  expect(getDisabledCompatibilityPatches({}, "1.3.14")).toEqual(new Set());

  const verifiedObsoletePatches = [
    "websocket",
    "miniflare",
    "platform-proxy-response-drain",
    "child-process-extra-fd",
    "web-streams-readable-constructor",
    "web-streams-writable-constructor",
    "web-streams-readable-prototype",
    "web-streams-writable-prototype",
    "workerd-child-process-unref",
    "workerd-child-process-stdio-unref",
    "wrangler-dev-env-runtime-errors",
    "wrangler-dev-env-persist",
  ] as const;
  for (const patchName of verifiedObsoletePatches) {
    expect(shouldInstallCompatibilityPatch(patchName, {}, "1.4.0")).toBeFalse();
  }

  const stillRequiredPatches = [
    "global-caches",
    "global-caches-install",
    "global-caches-default",
    "miniflare-form-data",
    "worker-threads",
    "wrangler-dev-env",
    "cloudflare-workers",
    "undici",
    "browser-rendering",
  ] as const;
  for (const patchName of stillRequiredPatches) {
    expect(shouldInstallCompatibilityPatch(patchName, {}, "1.4.0")).toBeTrue();
  }
});

test("only installs split patch groups when parent and child patches are enabled", () => {
  expect(
    shouldInstallCompatibilityPatchGroup(
      "web-streams",
      ["web-streams-readable-constructor", "web-streams-writable-constructor"],
      {},
      "1.3.14",
    ),
  ).toBeTrue();

  expect(
    shouldInstallCompatibilityPatchGroup(
      "web-streams",
      ["web-streams-readable-constructor", "web-streams-writable-constructor"],
      { BUN_TEST_CLOUDFLARE_DISABLED_PATCHES: "web-streams" },
      "1.3.14",
    ),
  ).toBeFalse();

  expect(
    shouldInstallCompatibilityPatchGroup(
      "web-streams",
      ["web-streams-readable-constructor", "web-streams-writable-constructor"],
      { BUN_TEST_CLOUDFLARE_DISABLED_PATCHES: "web-streams-readable-constructor,web-streams-writable-constructor" },
      "1.3.14",
    ),
  ).toBeFalse();
});

test("allows an explicit compatibility patch disable for every Bun version", () => {
  const environment = { BUN_TEST_CLOUDFLARE_DISABLED_PATCHES: "child-process-extra-fd,miniflare-request" };

  expect(shouldInstallCompatibilityPatch("child-process-extra-fd", environment, "1.3.14")).toBeFalse();
  expect(shouldInstallCompatibilityPatch("miniflare-request", environment, "1.3.14")).toBeFalse();
});

test("rejects unknown compatibility patch names", () => {
  expect(() => getDisabledCompatibilityPatches({ BUN_TEST_CLOUDFLARE_DISABLED_PATCHES: "missing" })).toThrow(
    "Unknown bun-test-cloudflare compatibility patch: missing",
  );
});
