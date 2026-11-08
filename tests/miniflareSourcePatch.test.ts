import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { applyMiniflareSourceTransforms, capnpArenaGrowth } from "../src/patches/MiniflareSourcePatch";

const installedMiniflareSource = () =>
  readFileSync(
    require.resolve("miniflare", { paths: [path.dirname(require.resolve("wrangler/package.json"))] }),
    "utf8",
  );

test("the Miniflare source transform fits the installed Miniflare", () => {
  const { applied, unmatched } = applyMiniflareSourceTransforms(installedMiniflareSource(), [capnpArenaGrowth]);

  expect(unmatched).toEqual([]);
  expect(applied).toEqual([capnpArenaGrowth.name]);
});

test("a Miniflare whose code no longer fits a transform runs without it, unchanged", () => {
  const source = installedMiniflareSource().replace(
    /new ArrayBuffer\(\s*srcBuffer\.byteLength\s*\+\s*minSize\s*\)/,
    "growBuffer(srcBuffer, minSize)",
  );

  const result = applyMiniflareSourceTransforms(source, [capnpArenaGrowth]);

  expect(result.unmatched).toEqual([capnpArenaGrowth.name]);
  expect(result.applied).toEqual([]);
  expect(result.source).toBe(source);
});

test("a Miniflare without the code a transform targets runs without it, unreported", () => {
  const source = "export const serializeConfig = () => new Uint8Array();\n";

  const result = applyMiniflareSourceTransforms(source, [capnpArenaGrowth]);

  expect(result).toEqual({ applied: [], unmatched: [], source });
});
