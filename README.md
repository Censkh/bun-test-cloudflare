# bun-test-cloudflare

Bun test compatibility and a typed harness wrapper for Cloudflare Workers projects that use Wrangler's `createTestHarness`.

## What It Provides

- `bun-test-cloudflare/setup`: Bun test preload that patches the runtime pieces Wrangler/Miniflare needs under Bun.
- `bun-test-cloudflare`: `createCloudflareHarness()` wrapper that turns named worker config into typed worker handles.

The setup currently fixes Bun/Miniflare websocket compatibility by adapting bare `ws` imports to Bun's native websocket client while preserving npm `ws` server exports for Miniflare internals. It also provides a minimal `cloudflare:workers` `DurableObject` shim for plain Bun module imports.

## Install

```sh
bun add -d bun-test-cloudflare
```

For a workspace package, use:

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
import { createCloudflareHarness } from "bun-test-cloudflare";
import path from "node:path";

const packageRoot = path.resolve(import.meta.dir, "../..");

export const harness = createCloudflareHarness({
  workers: {
    BACKEND: {
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

export type TestWorkers = ReturnType<typeof harness.workers>;
```

The object keys become the typed worker handles passed to `run()`.

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

`run()` starts the harness before the callback and always closes it afterwards, including when the callback throws.

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

The wrapped Wrangler server is available when needed:

```ts
await harness.run(async (workers, server) => {
  const logs = server.getLogs();
  const bucket = await workers.BACKEND.getR2Bucket("IMAGES_BUCKET");
});
```

You can also call `harness.listen()`, `harness.workers()`, and `harness.close()` manually for custom lifecycle control.
