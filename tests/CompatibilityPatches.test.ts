import { expect, test } from "bun:test";
import {
  getDisabledCompatibilityPatches,
  isBunVersionAtLeast,
  shouldInstallCompatibilityPatch,
  shouldInstallCompatibilityPatchGroup,
} from "../src/CompatibilityPatches";

test("recognises Bun 1.4 versions", () => {
  expect(isBunVersionAtLeast("1.3.14", "1.4.0")).toBeFalse();
  expect(isBunVersionAtLeast("1.4.0", "1.4.0")).toBeTrue();
  expect(isBunVersionAtLeast("1.4.0-canary.1", "1.4.0")).toBeFalse();
  expect(isBunVersionAtLeast("2.0.0", "1.4.0")).toBeTrue();
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
    "workerd-child-process-stdio-errors",
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

test("uses semver ranges for prereleases, metadata and invalid versions", () => {
  for (const version of [undefined, "", "invalid", "1.4", "1.4.2junk", "1.4.2-canary.1", "1.4.3-canary.1"]) {
    expect(isBunVersionAtLeast(version, "1.4.2")).toBeFalse();
  }
  expect(isBunVersionAtLeast("1.4.2+744846f84", "1.4.2")).toBeTrue();
  expect(getDisabledCompatibilityPatches({}, "invalid")).toEqual(new Set());
  expect(getDisabledCompatibilityPatches({}, "1.4.2-canary.1")).toEqual(new Set());
  expect(
    getDisabledCompatibilityPatches({ BUN_TEST_CLOUDFLARE_DISABLED_PATCHES: "miniflare-form-data" }, "1.4.2-canary.1"),
  ).toEqual(new Set(["miniflare-form-data"]));
});

test("disables only the two newly audited patches starting at Bun 1.4.2", () => {
  const addedPatches = ["worker-threads-fifo", "worker-threads-no-timeouts"] as const;
  const previous = getDisabledCompatibilityPatches({}, "1.4.1");
  for (const version of ["1.4.2", "1.4.2+build.1", "1.4.3", "1.5.0", "2.0.0"]) {
    expect(getDisabledCompatibilityPatches({}, version)).toEqual(new Set([...previous, ...addedPatches]));
    expect(shouldInstallCompatibilityPatch("miniflare-form-data", {}, version)).toBeTrue();
  }
  for (const patchName of addedPatches) {
    for (const version of ["1.3.14", "1.4.0", "1.4.1", "1.4.2-canary.1"]) {
      expect(shouldInstallCompatibilityPatch(patchName, {}, version)).toBeTrue();
    }
  }
});
