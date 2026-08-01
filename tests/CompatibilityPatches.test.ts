import { expect, test } from "bun:test";
import {
  getDisabledCompatibilityPatches,
  isBun14OrLater,
  isBunVersionAtLeast,
  shouldInstallCompatibilityPatch,
} from "../src/CompatibilityPatches";

test("recognises Bun 1.4 canary versions", () => {
  expect(isBun14OrLater("1.3.14")).toBeFalse();
  expect(isBun14OrLater("1.4.0-canary.1")).toBeTrue();
  expect(isBunVersionAtLeast("2.0.0", { major: 1, minor: 4, patch: 0 })).toBeTrue();
});

test("uses Bun 1.4 patch disables only on Bun 1.4 and later", () => {
  const environment = {
    BUN_TEST_CLOUDFLARE_BUN_1_4_DISABLED_PATCHES: "websocket, worker-threads,worker-threads-fifo",
  };

  expect(getDisabledCompatibilityPatches(environment, "1.3.14")).toEqual(new Set());
  expect(getDisabledCompatibilityPatches(environment, "1.4.0-canary.1")).toEqual(
    new Set([
      "web-streams",
      "undici-mark-as-uncloneable",
      "undici-commonjs-require",
      "miniflare-headers",
      "wrangler-guess-worker-format",
      "miniflare-loopback-launch",
      "miniflare-loopback-close",
      "global-caches-named",
      "websocket",
      "worker-threads",
      "worker-threads-fifo",
    ]),
  );
  expect(shouldInstallCompatibilityPatch("websocket", environment, "1.4.0-canary.1")).toBeFalse();
  expect(shouldInstallCompatibilityPatch("websocket", environment, "1.3.14")).toBeTrue();
});

test("automatically disables verified compatibility patches on Bun 1.4 and later", () => {
  expect(getDisabledCompatibilityPatches({}, "1.3.14")).toEqual(new Set());
  expect(getDisabledCompatibilityPatches({}, "1.4.0")).toEqual(
    new Set([
      "web-streams",
      "undici-mark-as-uncloneable",
      "undici-commonjs-require",
      "miniflare-headers",
      "wrangler-guess-worker-format",
      "miniflare-loopback-launch",
      "miniflare-loopback-close",
      "global-caches-named",
    ]),
  );
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
