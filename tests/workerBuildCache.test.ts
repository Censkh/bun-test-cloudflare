import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getWorkerBuildCacheDir, restoreCachedBuild, storeBuild } from "../src/WorkerBuildCache";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

/** A project with one source file, a finished build of it and the metafile esbuild wrote for it. */
const built = () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "worker-build-cache-"));
  roots.push(root);
  writeFileSync(path.join(root, "worker.ts"), "export default {};\n");
  const outdir = path.join(root, "out");
  mkdirSync(outdir);
  writeFileSync(path.join(outdir, "worker.js"), "built from worker.ts");
  const metafile = path.join(root, "meta.json");
  // Paths as esbuild reports them, relative to its working directory, and a virtual module.
  writeFileSync(metafile, JSON.stringify({ inputs: { "worker.ts": {}, "wrangler:modules-watch": {} } }));
  const cacheDir = getWorkerBuildCacheDir(root, "build-key", "wrangler");
  return { root, outdir, metafile, cacheDir };
};

test("a build is restored while its inputs are unchanged, even when only their mtimes moved", () => {
  const { root, outdir, metafile, cacheDir } = built();
  storeBuild(cacheDir, outdir, metafile, [root]);
  const next = path.join(root, "next-run");
  expect(restoreCachedBuild(cacheDir, next)).toBe(true);
  expect(readFileSync(path.join(next, "worker.js"), "utf8")).toBe("built from worker.ts");
  // Touched, with the same content: still the same build.
  const later = new Date(Date.now() + 60_000);
  utimesSync(path.join(root, "worker.ts"), later, later);
  expect(restoreCachedBuild(cacheDir, path.join(root, "third-run"))).toBe(true);
});

test("a changed or removed input builds again", () => {
  const { root, outdir, metafile, cacheDir } = built();
  storeBuild(cacheDir, outdir, metafile, [root]);
  writeFileSync(path.join(root, "worker.ts"), "export default { changed: true };\n");
  expect(restoreCachedBuild(cacheDir, path.join(root, "changed"))).toBe(false);
  expect(existsSync(path.join(root, "changed"))).toBe(false);
  storeBuild(cacheDir, outdir, metafile, [root]);
  rmSync(path.join(root, "worker.ts"));
  expect(restoreCachedBuild(cacheDir, path.join(root, "removed"))).toBe(false);
});

test("a build with no inputs to check is never cached", () => {
  const { root, outdir, cacheDir } = built();
  const empty = path.join(root, "empty-meta.json");
  writeFileSync(empty, JSON.stringify({ inputs: { "wrangler:modules-watch": {} } }));
  storeBuild(cacheDir, outdir, empty, [root]);
  expect(restoreCachedBuild(cacheDir, path.join(root, "next-run"))).toBe(false);
});
