import { expect, test } from "bun:test";
import path from "node:path";
import { shouldInstallCompatibilityPatch } from "../src/CompatibilityPatches";
import { installMiniflareSourcePatch } from "../src/patches/MiniflareSourcePatch";

const miniflarePath = require.resolve("miniflare", {
  paths: [path.dirname(require.resolve("wrangler/package.json"))],
});

// Test files share a process, and an earlier one may have loaded Miniflare without the patch.
delete require.cache[miniflarePath];
installMiniflareSourcePatch({
  capnpArenaGrowth: true,
  proxyCallRetention: false,
  stoppableSocketTracking: false,
  loopbackBodyCancellation: false,
});

// Shaped like a harness generation: several slots, each a large bundle followed by small modules and bindings.
const largeConfig = () => ({
  services: Array.from({ length: 4 }, (_, slot) => ({
    name: `worker-${slot}`,
    worker: {
      compatibilityDate: "2026-01-01",
      modules: [
        { name: "worker.js", esModule: "a".repeat(4 * 1024 * 1024) },
        ...Array.from({ length: 200 }, (_, index) => ({ name: `module-${index}.js`, esModule: "export default 1;" })),
      ],
      bindings: Array.from({ length: 200 }, (_, index) => ({ name: `BINDING_${index}`, text: "value" })),
    },
  })),
});

const serializeCountingAllocations = (config: object) => {
  const { serializeConfig } = require(miniflarePath) as typeof import("miniflare");
  const OriginalArrayBuffer = globalThis.ArrayBuffer;
  let allocatedBytes = 0;
  globalThis.ArrayBuffer = new Proxy(OriginalArrayBuffer, {
    construct(target, args, newTarget) {
      allocatedBytes += Number(args[0] ?? 0);
      return Reflect.construct(target, args, newTarget);
    },
  });
  try {
    const serialized = serializeConfig(config as Parameters<typeof serializeConfig>[0]);
    return { allocatedBytes, serialized };
  } finally {
    globalThis.ArrayBuffer = OriginalArrayBuffer;
  }
};

test.skipIf(!shouldInstallCompatibilityPatch("miniflare-capnp-arena-growth"))(
  "Miniflare serializes a large workerd config with linear arena growth",
  () => {
    const { allocatedBytes, serialized } = serializeCountingAllocations(largeConfig());

    // Doubling allocates a small multiple of the output (about 5x here); growing by each
    // allocation's size copies the whole arena once per small struct after the bundles (about 15x).
    expect(serialized.byteLength).toBeGreaterThan(16 * 1024 * 1024);
    expect(allocatedBytes).toBeLessThan(serialized.byteLength * 8);
  },
);
