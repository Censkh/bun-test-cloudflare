import { mock } from "bun:test";

export const installCloudflareWorkersPatch = () => {
  mock.module("cloudflare:workers", () => ({
    DurableObject: class DurableObject {
      protected ctx: unknown;
      protected env: unknown;

      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
    WorkerEntrypoint: class WorkerEntrypoint {
      protected ctx: unknown;
      protected env: unknown;

      constructor(ctx: unknown, env: unknown) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  }));
};
