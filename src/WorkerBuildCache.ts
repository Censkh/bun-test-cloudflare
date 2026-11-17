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
 *
 * The modules Wrangler's rules collect (Wasm, text and data files) are external to esbuild, so its
 * inputs leave them out: each is traced from the input that imports it to the file whose content its
 * collected name's hash is (`collectedModuleSources`), and a build with one that can't be traced isn't
 * kept, as its changes would go unseen.
 */

type InputRecord = { size: number; mtimeMs: number; sha256: string };
/**
 * What a manifest records: entries of another version (version 1's left out the modules Wrangler
 * collected) are built again.
 */
const MANIFEST_VERSION = 2;

type Manifest = { version: number; inputs: Record<string, InputRecord> };

const sha256File = (file: string) => crypto.createHash("sha256").update(readFileSync(file)).digest("hex");
const sha1File = (file: string) => crypto.createHash("sha1").update(readFileSync(file)).digest("hex");

type Metafile = {
  inputs?: Record<string, { imports?: { path: string; external?: boolean }[] }>;
};

/** A module Wrangler collected, as its importer refers to it: `./<sha1 of its content>-<its file name>`. */
const COLLECTED_MODULE = /^\.\/([0-9a-f]{40})-([^/]+)$/;

/** The quoted strings in a source file: its import specifiers among them. */
const quotedStrings = (source: string) => [...source.matchAll(/(["'`])([^"'`\n]+?)\1/g)].map((match) => match[2]!);

/**
 * The source file of every module Wrangler collected for the build, or `undefined` when one can't be
 * found: among the specifiers its importer quotes with the module's file name, the one that resolves (from
 * the importer's directory, or as a package) to a file whose content has the hash in its collected name.
 */
export const collectedModuleSources = (
  metafile: Metafile,
  inputFile: (input: string) => string | undefined,
): string[] | undefined => {
  const sources: string[] = [];
  for (const [input, { imports = [] }] of Object.entries(metafile.inputs ?? {})) {
    const collected = imports.flatMap((entry) => {
      const match = entry.external ? COLLECTED_MODULE.exec(entry.path) : null;
      return match ? [{ hash: match[1]!, name: match[2]! }] : [];
    });
    if (collected.length === 0) continue;
    const importer = inputFile(input);
    if (!importer) return undefined;
    const specifiers = quotedStrings(readFileSync(importer, "utf8")).map((specifier) => specifier.split("?")[0]!);
    for (const { hash, name } of collected) {
      const source = specifiers
        .filter((specifier) => path.basename(specifier) === name)
        .flatMap((specifier) => {
          try {
            return [
              specifier.startsWith(".")
                ? path.resolve(path.dirname(importer), specifier)
                : Bun.resolveSync(specifier, path.dirname(importer)),
            ];
          } catch {
            return [];
          }
        })
        .find((file) => existsSync(file) && statSync(file).isFile() && sha1File(file) === hash);
      if (!source) return undefined;
      sources.push(source);
    }
  }
  return sources;
};

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
  if (manifest.version !== MANIFEST_VERSION || !existsSync(output) || !isCurrent(manifest)) return false;
  rmSync(outdir, { force: true, recursive: true });
  // A copy-on-write clone where the file system has them (APFS, Btrfs): a build is tens of megabytes.
  cpSync(output, outdir, { recursive: true, mode: constants.COPYFILE_FICLONE });
  return true;
};

/**
 * Keeps `outdir` (a finished dry-run's output) as the cache entry, with the inputs esbuild's metafile lists
 * (relative to esbuild's working directory: the first of `workingDirectories` where an input exists) and
 * the modules Wrangler collected (`collectedModuleSources`). Written aside and renamed into place, so a run reading it never sees half
 * of one; a failure to cache never fails the build.
 */
export const storeBuild = (cacheDir: string, outdir: string, metafilePath: string, workingDirectories: string[]) => {
  try {
    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as Metafile;
    const inputFile = (input: string) =>
      workingDirectories
        .map((directory) => path.resolve(directory, input))
        .find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
    const modules = collectedModuleSources(metafile, inputFile);
    if (!modules) return;
    const inputs: Record<string, InputRecord> = {};
    for (const file of [...Object.keys(metafile.inputs ?? {}).map(inputFile), ...modules]) {
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
    writeFileSync(
      path.join(staging, "manifest.json"),
      JSON.stringify({ version: MANIFEST_VERSION, inputs } satisfies Manifest),
    );
    rmSync(cacheDir, { force: true, recursive: true });
    renameSync(staging, cacheDir);
  } catch {
    // Caching is only an optimization.
  }
};
