import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  copyAdditionalModules,
  findAdditionalModuleFiles,
  getAdditionalModuleSourceRoots,
} from "../src/AdditionalModules";

const testRoot = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-additional-modules-"));

afterAll(() => {
  rmSync(testRoot, { force: true, recursive: true });
});

const writeFile = (filePath: string, contents = "") => {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
};

test("source roots stop at the nearest directory with a lockfile", () => {
  const project = path.join(testRoot, "lockfile-project");
  const worker = path.join(project, "packages/worker");
  writeFile(path.join(project, "bun.lock"));
  mkdirSync(worker, { recursive: true });

  expect(getAdditionalModuleSourceRoots(worker)).toEqual([worker, path.join(project, "packages"), project]);
});

test("source roots stop at the nearest directory with .git", () => {
  const project = path.join(testRoot, "git-project");
  const worker = path.join(project, "worker");
  mkdirSync(path.join(project, ".git"), { recursive: true });
  mkdirSync(worker, { recursive: true });

  expect(getAdditionalModuleSourceRoots(worker, project)).toEqual([worker, project]);
});

test("wildcards skip node_modules and hidden directories", () => {
  const root = path.join(testRoot, "wildcard-skips");
  writeFile(path.join(root, "fonts/Inter.ttf"));
  writeFile(path.join(root, "packages/shared/fonts/Noto.ttf"));
  writeFile(path.join(root, "node_modules/pkg/Font.ttf"));
  writeFile(path.join(root, "packages/shared/node_modules/pkg/Font.ttf"));
  writeFile(path.join(root, ".claude/worktrees/agent/fonts/Inter.ttf"));

  expect(findAdditionalModuleFiles(root, "**/*.ttf").toSorted()).toEqual([
    "fonts/Inter.ttf",
    "packages/shared/fonts/Noto.ttf",
  ]);
});

test("globs reach node_modules and hidden directories by naming them", () => {
  const root = path.join(testRoot, "literal-prefix");
  writeFile(path.join(root, "node_modules/payload/dist/uploads/isImage.js"));
  writeFile(path.join(root, ".generated/locale.js"));

  expect(findAdditionalModuleFiles(root, "node_modules/payload/dist/uploads/*.js")).toEqual([
    "node_modules/payload/dist/uploads/isImage.js",
  ]);
  expect(findAdditionalModuleFiles(root, "./.generated/*.js")).toEqual([".generated/locale.js"]);
  expect(findAdditionalModuleFiles(root, ".generated/locale.js")).toEqual([".generated/locale.js"]);
});

test("globs without ** only match at their own depth", () => {
  const root = path.join(testRoot, "fixed-depth");
  writeFile(path.join(root, "assets/locale.js"));
  writeFile(path.join(root, "assets/nested/other.js"));

  expect(findAdditionalModuleFiles(root, "assets/*.js")).toEqual(["assets/locale.js"]);
});

test("symlinked files match but symlinked directories are not followed", () => {
  const root = path.join(testRoot, "symlinks");
  writeFile(path.join(root, "real/data.txt"));
  symlinkSync(path.join(root, "real/data.txt"), path.join(root, "link.txt"));
  symlinkSync(path.join(root, "real"), path.join(root, "linked-dir"));

  expect(findAdditionalModuleFiles(root, "**/*.txt").toSorted()).toEqual(["link.txt", "real/data.txt"]);
});

test("missing source roots and literal paths match nothing", () => {
  const missingRoot = path.join(testRoot, "does-not-exist");

  expect(findAdditionalModuleFiles(missingRoot, "**/*.ttf")).toEqual([]);
  expect(findAdditionalModuleFiles(missingRoot, "fonts/Inter.ttf")).toEqual([]);
});

test("copies matched modules into the build output and prefers earlier source roots", () => {
  const project = path.join(testRoot, "copy-project");
  const worker = path.join(project, "worker");
  const outdir = path.join(worker, "node_modules/.btcf/worker-build/run-1/worker-0123456789abcdef");
  writeFile(path.join(worker, "fonts/Inter.ttf"), "worker font");
  writeFile(path.join(project, "fonts/Inter.ttf"), "project font");
  writeFile(path.join(project, "shared/fonts/Noto.ttf"), "shared font");
  writeFile(path.join(project, "docs/readme.md"), "not a module");

  copyAdditionalModules({
    outdir,
    rules: [
      { type: "Data", globs: ["**/*.ttf"] },
      { type: "CompiledWasm", globs: ["**/*.md"] },
    ],
    sourceRoots: [worker, project],
  });

  expect(readFileSync(path.join(outdir, "fonts/Inter.ttf"), "utf8")).toBe("worker font");
  expect(readFileSync(path.join(outdir, "shared/fonts/Noto.ttf"), "utf8")).toBe("shared font");
  expect(findAdditionalModuleFiles(outdir, "**/*").toSorted()).toEqual([
    "fonts/Inter.ttf",
    "shared/fonts/Noto.ttf",
    "worker/fonts/Inter.ttf",
  ]);
});
