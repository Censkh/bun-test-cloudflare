import crypto from "node:crypto";
import {
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Worker builds kept between `bun test` runs: a build (Wrangler's dry-run output) is reused while every
 * file esbuild read for it is unchanged, so a run after one that built the same Workers skips Wrangler
 * entirely. A cache entry is one build per build key, and its manifest records each input's size, mtime
 * and content hash: an input whose size and mtime are unchanged is taken as unchanged, any other is
 * compared by content, and a missing or changed input rebuilds. Inputs esbuild reports that aren't files
 * (Wrangler's own virtual modules) are generated from the config, which the build key already covers.
 */

type InputRecord = { size: number; mtimeMs: number; sha256: string };
type Manifest = { inputs: Record<string, InputRecord> };

const sha256File = (file: string) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");

export const getWorkerBuildCacheRoot = (baseDirectory: string) =>
  path.join(baseDirectory, "node_modules/.btcf/worker-build-cache");

/** The cache entry of a build: its build key with what else decides the output (Wrangler and its patches). */
export const getWorkerBuildCacheDir = (baseDirectory: string, buildKey: string, toolKey: string) =>
  path.join(
    getWorkerBuildCacheRoot(baseDirectory),
    crypto.createHash("sha256").update(`${buildKey}\n${toolKey}`).digest("hex").slice(0, 32),
  );

/** Whether every input the cached build read is as it was, so the build would come out the same. */
const isCurrent = (manifest: Manifest) =>
  Object.entries(manifest.inputs).every(([file, recorded]) => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(file);
    } catch {
      return false;
    }
    if (stats.size !== recorded.size) return false;
    if (stats.mtimeMs === recorded.mtimeMs) return true;
    return sha256File(file) === recorded.sha256;
  });

/** Copies the cached build into `outdir` when its inputs are unchanged; returns whether it did. */
export const restoreCachedBuild = (cacheDir: string, outdir: string) => {
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(cacheDir, "manifest.json"), "utf8")) as Manifest;
  } catch {
    return false;
  }
  const output = path.join(cacheDir, "output");
  if (!existsSync(output) || !isCurrent(manifest)) return false;
  rmSync(outdir, { force: true, recursive: true });
  // A copy-on-write clone where the file system has them (APFS, Btrfs): a build is tens of megabytes.
  cpSync(output, outdir, { recursive: true, mode: constants.COPYFILE_FICLONE });
  return true;
};

/**
 * Keeps `outdir` (a finished dry-run's output) as the cache entry, with the inputs esbuild's metafile lists
 * (relative to esbuild's working directory: the first of `workingDirectories` where an input exists). Written aside and renamed into place, so a run reading it never sees half
 * of one; a failure to cache never fails the build.
 */
export const storeBuild = (cacheDir: string, outdir: string, metafilePath: string, workingDirectories: string[]) => {
  try {
    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as { inputs?: Record<string, unknown> };
    const inputs: Record<string, InputRecord> = {};
    for (const input of Object.keys(metafile.inputs ?? {})) {
      const file = workingDirectories
        .map((directory) => path.resolve(directory, input))
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
      if (!file) continue;
      const stats = statSync(file);
      inputs[file] = { size: stats.size, mtimeMs: stats.mtimeMs, sha256: sha256File(file) };
    }
    // Nothing to check it against: it would count as current forever.
    if (Object.keys(inputs).length === 0) return;
    const staging = `${cacheDir}.${process.pid}.tmp`;
    rmSync(staging, { force: true, recursive: true });
    mkdirSync(staging, { recursive: true });
    cpSync(outdir, path.join(staging, "output"), { recursive: true, mode: constants.COPYFILE_FICLONE });
    writeFileSync(path.join(staging, "manifest.json"), JSON.stringify({ inputs } satisfies Manifest));
    rmSync(cacheDir, { force: true, recursive: true });
    renameSync(staging, cacheDir);
  } catch {
    // Caching is only an optimization.
  }
};
