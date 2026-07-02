import { mock } from "bun:test";
import Module from "node:module";
import path from "node:path";

type WorkerThreadsWithMarkAsUncloneable = typeof import("node:worker_threads") & {
  markAsUncloneable?: (object: object) => void;
};

const installMarkAsUncloneableFallback = () => {
  const workerThreads = require("node:worker_threads") as WorkerThreadsWithMarkAsUncloneable;
  workerThreads.markAsUncloneable ??= () => {};
};

export const installUndiciPatch = () => {
  installMarkAsUncloneableFallback();

  const undiciPackageJsonPath = require.resolve("undici/package.json");
  const undiciIndexPath = path.join(path.dirname(undiciPackageJsonPath), "index.js");
  const undici = require(undiciIndexPath);

  const originalRequire = Module.prototype.require;
  Module.prototype.require = function require(request: string) {
    if (request === "undici") {
      return undici;
    }

    return originalRequire.call(this, request);
  };

  mock.module("undici", () => ({
    ...undici,
    default: undici,
  }));
};
