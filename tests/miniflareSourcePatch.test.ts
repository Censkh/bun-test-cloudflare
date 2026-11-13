import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyMiniflareSourceTransforms,
  capnpArenaGrowth,
  proxyCallRetention,
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
  ]);

  expect(unmatched).toEqual([]);
  expect(applied).toContain(proxyCallRetention.name);
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
