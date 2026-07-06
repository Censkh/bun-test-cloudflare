# bun-test-cloudflare

[![npm version](https://img.shields.io/npm/v/bun-test-cloudflare.svg)](https://www.npmjs.com/package/bun-test-cloudflare)

Bun test support and a typed harness wrapper for Cloudflare Workers projects, with runtime compatibility patches for running Wrangler test servers under Bun.

## What It Provides

- `bun-test-cloudflare/setup`: Bun test preload that patches the runtime pieces Wrangler/Miniflare needs under Bun.
- `bun-test-cloudflare`: `createCloudflareHarness()` wrapper that turns named worker config into typed worker handles.

The setup currently fixes Bun/Miniflare websocket compatibility by adapting bare `ws` imports to Bun's native websocket client while preserving npm `ws` server exports for Miniflare internals. It also provides a minimal `cloudflare:workers` `DurableObject` shim for plain Bun module imports.

## Install

```sh
bun add -d bun-test-cloudflare
```

For a workspace package, use:

## Wrangler Compatibility

`bun-test-cloudflare` requires `wrangler >= 4.104.0`.

## Configure Bun

Preload the setup before app-specific test setup:

```toml
[test]
preload = ["bun-test-cloudflare/setup", "./src/tests/setup.ts"]
```

If you do not need app-specific setup, use only:

```toml
[test]
preload = ["bun-test-cloudflare/setup"]
```

## Create A Typed Harness

Create one test harness module for your package and export the configured harness:

```ts
// src/tests/harness.ts
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";
import path from "node:path";

type BackendBindings = {
  IMAGES_BUCKET: R2Bucket;
};

const packageRoot = path.resolve(import.meta.dir, "../..");

export const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
      bindings: typeToken<BackendBindings>(),
      configPath: path.join(packageRoot, "wrangler.toml"),
      name: "my-backend-worker",
      vars: {
        APP_ENV: "test",
      },
    },
    CMS: {
      configPath: path.join(packageRoot, "../cms/wrangler.toml"),
      name: "my-cms-worker",
      secrets: {
        PAYLOAD_SECRET: "test",
      },
    },
  },
});

export type TestWorkers = Parameters<Parameters<typeof harness.run>[0]>[0];
```

The object keys become the typed worker handles passed to `run()`.
The optional `bindings` token is type-only metadata for `worker.getEnv()` and is not passed to Wrangler.

When a worker uses `configPath`, `bun-test-cloudflare` reads that Wrangler config, injects
`define["process.env.NODE_ENV"] = "'test'"`, and runs `wrangler deploy --dry-run --outdir`
once for that harness. Build output is written to
`node_modules/.btcf/worker-build/<worker-name>/worker.js`. Test runs then use that script
with `no_bundle = true`, so Wrangler does not rerun its esbuild bundle step for every
`run()`.

## Use In Tests

```ts
import { expect, test } from "bun:test";
import { harness } from "./harness";

test("calls the backend worker", async () => {
  await harness.run(async (workers) => {
    const response = await workers.BACKEND.fetch("https://example.com/health");

    expect(response.status).toBe(200);
  });
});
```

`run()` creates a fresh Wrangler test server, starts it before the callback, and always closes it afterwards, including when the callback throws.

## Lifecycle Events

Use `events.beforeRun` for per-run setup after Wrangler has started and before the test callback runs:

```ts
const harness = createCloudflareHarness({
  events: {
    beforeRun: async (workers) => {
      const env = await workers.BACKEND.getEnv();
      await env.DB.prepare("SELECT 1").run();
    },
  },
  workers: {
    BACKEND: { configPath: "./wrangler.toml" },
  },
});
```

## Worker Names

`createCloudflareHarness()` uses each worker config's `name` when calling Wrangler's `server.getWorker(name)`. If `name` is omitted, it falls back to the object key:

```ts
const harness = createCloudflareHarness({
  workers: {
    BACKEND: { configPath: "./wrangler.toml" },
  },
});

await harness.run(async (workers) => {
  await workers.BACKEND.fetch("https://example.com");
});
```

## Direct Server Access

The current Wrangler server is available inside `run()` when needed:

```ts
await harness.run(async (workers, server) => {
  const logs = server.getLogs();
  const env = await workers.BACKEND.getEnv();
  await env.IMAGES_BUCKET.put("fixture.png", new Uint8Array());
});
```

## Access The Active Run Context

Code called inside `harness.run()` can read the active workers and server without threading them through every helper:

```ts
import { getCloudflareHarnessRunContext } from "bun-test-cloudflare";

export async function createFixture() {
  const { workers } = getCloudflareHarnessRunContext<{
    BACKEND: { configPath: string; name: string };
  }>();
  const env = await workers.BACKEND.getEnv();

  await env.MY_BUCKET.put("fixture.txt", "hello");
}
```

The run context is backed by `AsyncLocalStorage`, so it is scoped to the current `harness.run()` callback and async work started from it. Calling `getCloudflareHarnessRunContext()` outside `harness.run()` throws.
