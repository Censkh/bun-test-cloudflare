import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyMiniflareSourceTransforms,
  capnpArenaGrowth,
  proxyCallRetention,
  stoppableSocketTracking,
} from "../src/patches/MiniflareSourcePatch";

const installedMiniflareSource = () =>
  readFileSync(
    require.resolve("miniflare", { paths: [path.dirname(require.resolve("wrangler/package.json"))] }),
    "utf8",
  );

// capnp-es's single-segment allocator before and after Miniflare 5 made it double the buffer.
const clampedArenaAllocator = `function allocate$1(minSize, segments, s) {
  const srcBuffer = segments.length > 0 ? segments[0].buffer : s.buffer;
  minSize = minSize < MIN_SINGLE_SEGMENT_GROWTH ? MIN_SINGLE_SEGMENT_GROWTH : padToWord$1(minSize);
  s.buffer = new ArrayBuffer(srcBuffer.byteLength + minSize);
  return new ArenaAllocationResult(0, s.buffer);
}
`;
const doublingArenaAllocator = `function allocate$1(minSize, segments, s) {
  const srcBuffer = segments.length > 0 ? segments[0].buffer : s.buffer;
  const growth = Math.max(padToWord$1(minSize), MIN_SINGLE_SEGMENT_GROWTH, srcBuffer.byteLength);
  s.buffer = new ArrayBuffer(srcBuffer.byteLength + growth);
  return new ArenaAllocationResult(0, s.buffer);
}
`;

test("the Miniflare source transforms fit the installed Miniflare", () => {
  const { applied, unmatched } = applyMiniflareSourceTransforms(installedMiniflareSource(), [
    capnpArenaGrowth,
    proxyCallRetention,
    stoppableSocketTracking,
  ]);

  expect(unmatched).toEqual([]);
  expect(applied).toContain(proxyCallRetention.name);
  expect(applied).toContain(stoppableSocketTracking.name);
});

test("capnp's clamped arena growth doubles the buffer instead", () => {
  const result = applyMiniflareSourceTransforms(clampedArenaAllocator, [capnpArenaGrowth]);

  expect(result.applied).toEqual([capnpArenaGrowth.name]);
  expect(result.source).toContain(
    "s.buffer = new ArrayBuffer(srcBuffer.byteLength + Math.max(minSize, srcBuffer.byteLength));",
  );
});

test("a capnp arena that already doubles its buffer is left alone, unreported", () => {
  const result = applyMiniflareSourceTransforms(doublingArenaAllocator, [capnpArenaGrowth]);

  expect(result).toEqual({ applied: [], unmatched: [], source: doublingArenaAllocator });
});

test("a Miniflare whose code no longer fits a transform runs without it, unchanged", () => {
  const source = clampedArenaAllocator.replace(
    "new ArrayBuffer(srcBuffer.byteLength + minSize)",
    "growBuffer(srcBuffer, minSize)",
  );

  const result = applyMiniflareSourceTransforms(source, [capnpArenaGrowth]);

  expect(result.unmatched).toEqual([capnpArenaGrowth.name]);
  expect(result.applied).toEqual([]);
  expect(result.source).toBe(source);
});

test("a Miniflare without the code a transform targets runs without it, unreported", () => {
  const source = "export const serializeConfig = () => new Uint8Array();\n";

  const result = applyMiniflareSourceTransforms(source, [capnpArenaGrowth, proxyCallRetention]);

  expect(result).toEqual({ applied: [], unmatched: [], source });
});

type FakeSocket = EventEmitter & { ended: number; end(): void; destroy(): void };

/** Miniflare's bundled stoppable, which stops its loopback server, with `transforms` applied. */
const installedStoppable = (transforms: Parameters<typeof applyMiniflareSourceTransforms>[1]) => {
  const source = installedMiniflareSource();
  const exportsAt = source.indexOf("module2.exports = (server, grace) => {");
  // Its `https` import sits just above the export.
  const start = source.lastIndexOf("var https", exportsAt);
  const end = source.indexOf("\n    };\n  }\n});", exportsAt);
  const body = applyMiniflareSourceTransforms(source.slice(start, end + "\n    };".length), transforms).source;
  const module2 = { exports: undefined as unknown };
  new Function("require", "module2", body)(require, module2);
  return module2.exports as (
    server: EventEmitter,
    grace: number,
  ) => EventEmitter & {
    stop(callback: (error?: Error) => void): void;
  };
};

const fakeSocket = (): FakeSocket =>
  Object.assign(new EventEmitter(), {
    ended: 0,
    end() {
      this.ended += 1;
    },
    destroy() {},
  });

test("stopping Miniflare's loopback server survives a request whose socket Bun detached before it finished", async () => {
  const uncaught: unknown[] = [];
  const recordUncaught = (error: unknown) => uncaught.push(error);
  process.on("uncaughtException", recordUncaught);
  try {
    const stoppable = installedStoppable([stoppableSocketTracking]);
    const server = stoppable(Object.assign(new EventEmitter(), { close: (done: () => void) => done() }), 0);
    const detached = fakeSocket();
    const open = fakeSocket();
    server.emit("connection", detached);
    server.emit("connection", open);
    const request = { socket: detached as FakeSocket | null };
    const response = new EventEmitter();
    server.emit("request", request, response);
    // Bun detaches the socket once the response is written, and the socket closes first.
    detached.emit("close");
    request.socket = null;
    response.emit("finish");

    await new Promise<void>((resolve, reject) => server.stop((error) => (error ? reject(error) : resolve())));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(uncaught).toEqual([]);
    expect(open.ended).toBeGreaterThan(0);
    expect(detached.ended).toBe(0);
  } finally {
    process.off("uncaughtException", recordUncaught);
  }
});
