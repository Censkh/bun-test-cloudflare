import { mock } from "bun:test";
import Module from "node:module";
import path from "node:path";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";

type WorkerThreadsWithMarkAsUncloneable = typeof import("node:worker_threads") & {
  markAsUncloneable?: (object: object) => void;
};

const installMarkAsUncloneableFallback = () => {
  const workerThreads = require("node:worker_threads") as WorkerThreadsWithMarkAsUncloneable;
  workerThreads.markAsUncloneable ??= () => {};
};

/**
 * Miniflare's fetch() returns `new Response(response.body, response)` and drops undici's own
 * Response. undici cancels a fetch Response's unread body once that object is garbage collected,
 * so a collection before the caller reads the copy cancels the body it still holds ("Body is
 * unusable: Body has already been read"). Keep each fetch Response alive as long as its body
 * stream is: the copy holds the stream, and the stream holds the original through this map.
 * Patched before the module copies below, which Miniflare then receives.
 */
const retainFetchResponses = (undici: { fetch: (...args: unknown[]) => Promise<Response> }) => {
  const originalFetch = undici.fetch;
  const retained = new WeakMap<object, Response>();
  undici.fetch = async function fetch(this: unknown, ...args: unknown[]) {
    const response = await originalFetch.apply(this, args);
    if (response?.body) retained.set(response.body, response);
    return response;
  };
};

export const installUndiciPatch = () => {
  if (shouldInstallCompatibilityPatch("undici-mark-as-uncloneable")) {
    installMarkAsUncloneableFallback();
  }

  const undiciPackageJsonPath = require.resolve("undici/package.json");
  const undiciIndexPath = path.join(path.dirname(undiciPackageJsonPath), "index.js");
  const undici = require(undiciIndexPath);
  if (shouldInstallCompatibilityPatch("undici-fetch-response-retention")) {
    retainFetchResponses(undici);
  }

  if (shouldInstallCompatibilityPatch("undici-commonjs-require")) {
    const originalRequire = Module.prototype.require;
    Module.prototype.require = function require(request: string) {
      if (request === "undici") {
        return undici;
      }

      return originalRequire.call(this, request);
    };
  }

  if (shouldInstallCompatibilityPatch("undici-esm-module")) {
    mock.module("undici", () => ({
      ...undici,
      default: undici,
    }));
  }
};
