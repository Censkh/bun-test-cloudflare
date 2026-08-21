import { mock } from "bun:test";
import { shouldInstallCompatibilityPatch } from "../CompatibilityPatches";

export const installCloudflareWorkersPatch = () => {
  const workersModule: Record<string, unknown> = {};

  if (shouldInstallCompatibilityPatch("cloudflare-workers-durable-object")) {
    workersModule.DurableObject = class DurableObject {
      protected ctx: unknown;
      protected env: unknown;

      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    };
  }

  if (shouldInstallCompatibilityPatch("cloudflare-workers-worker-entrypoint")) {
    workersModule.WorkerEntrypoint = class WorkerEntrypoint {
      protected ctx: unknown;
      protected env: unknown;

      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    };
  }

  mock.module("cloudflare:workers", () => workersModule);
};
