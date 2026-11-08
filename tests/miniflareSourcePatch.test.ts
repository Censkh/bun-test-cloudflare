import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  applyMiniflareSourceTransforms,
  capnpArenaGrowth,
  proxyClassMembers,
} from "../src/patches/MiniflareSourcePatch";

const installedMiniflareSource = () =>
  readFileSync(
    require.resolve("miniflare", { paths: [path.dirname(require.resolve("wrangler/package.json"))] }),
    "utf8",
  );

test("both Miniflare source transforms fit the installed Miniflare", () => {
  const { applied, unmatched } = applyMiniflareSourceTransforms(installedMiniflareSource(), [
    capnpArenaGrowth,
    proxyClassMembers,
  ]);

  expect(unmatched).toEqual([]);
  expect(applied).toEqual([capnpArenaGrowth.name, proxyClassMembers.name]);
});

test("a Miniflare whose code no longer fits a transform runs without it, unchanged", () => {
  const source = installedMiniflareSource().replace("if (maybeKnown !== void 0)", "if (maybeKnown !== undefined)");

  const result = applyMiniflareSourceTransforms(source, [proxyClassMembers]);

  expect(result.unmatched).toEqual([proxyClassMembers.name]);
  expect(result.applied).toEqual([]);
  expect(result.source).toBe(source);
});

test("a Miniflare without the code a transform targets runs without it, unreported", () => {
  const source = "export const serializeConfig = () => new Uint8Array();\n";

  const result = applyMiniflareSourceTransforms(source, [capnpArenaGrowth, proxyClassMembers]);

  expect(result).toEqual({ applied: [], unmatched: [], source });
});
