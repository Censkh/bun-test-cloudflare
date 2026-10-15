import { copyFileSync, type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { isErrnoException } from "./WorkerBuildOutput";

const additionalModuleRuleTypes = new Set(["CommonJS", "Data", "ESModule", "Text"]);
const projectRootMarkers = [".git", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
const globMagicPattern = /[*?[\]{}!]/;

const isProjectRoot = (directory: string) => {
  if (projectRootMarkers.some((marker) => existsSync(path.join(directory, marker)))) return true;
  try {
    const packageJson = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as {
      workspaces?: unknown;
    };
    return packageJson.workspaces !== undefined;
  } catch {
    return false;
  }
};

const findProjectRoot = (directory: string) => {
  let currentDirectory = path.resolve(directory);
  while (true) {
    if (isProjectRoot(currentDirectory)) return currentDirectory;
    const parentDirectory = path.dirname(currentDirectory);
    if (parentDirectory === currentDirectory) return undefined;
    currentDirectory = parentDirectory;
  }
};

/** Returns the directory and its ancestors up to the project root, or only the directory outside a project. */
const getAncestorDirectories = (directory: string) => {
  const directories: string[] = [];
  let currentDirectory = path.resolve(directory);
  const projectRoot = findProjectRoot(currentDirectory);

  while (true) {
    directories.push(currentDirectory);
    if (projectRoot === undefined || currentDirectory === projectRoot) {
      return directories;
    }
    currentDirectory = path.dirname(currentDirectory);
  }
};

export const getAdditionalModuleSourceRoots = (...directories: Array<string | undefined>) =>
  Array.from(
    new Set(
      directories.flatMap((directory) => (directory && existsSync(directory) ? getAncestorDirectories(directory) : [])),
    ),
  );

const isMissingPathError = (error: unknown) =>
  isErrnoException(error) && (error.code === "ENOENT" || error.code === "ENOTDIR");

const readDirectoryEntries = (directory: string): Dirent[] => {
  try {
    return readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
};

const isFile = (filePath: string) => {
  try {
    return statSync(filePath).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
};

/** Wildcards never descend into dependency or hidden directories; a glob reaches them by naming them literally. */
const isSkippedWildcardDirectory = (name: string) => name === "node_modules" || name.startsWith(".");

/** Lists the files under `sourceRoot` that match `glob`, as `/`-separated paths relative to `sourceRoot`. */
export const findAdditionalModuleFiles = (sourceRoot: string, glob: string): string[] => {
  const segments = glob.split("/").filter((segment) => segment !== "" && segment !== ".");
  const firstMagicIndex = segments.findIndex((segment) => globMagicPattern.test(segment));
  if (firstMagicIndex === -1) {
    const relativePath = segments.join("/");
    return isFile(path.join(sourceRoot, relativePath)) ? [relativePath] : [];
  }

  const matcher = new Bun.Glob(segments.join("/"));
  const literalPrefix = segments.slice(0, firstMagicIndex);
  const maxDepth = segments.slice(firstMagicIndex).includes("**") ? Number.POSITIVE_INFINITY : segments.length;
  const matches: string[] = [];

  const visit = (relativeSegments: string[]) => {
    for (const entry of readDirectoryEntries(path.join(sourceRoot, ...relativeSegments))) {
      const entrySegments = [...relativeSegments, entry.name];
      if (entry.isDirectory()) {
        if (entrySegments.length < maxDepth && !isSkippedWildcardDirectory(entry.name)) {
          visit(entrySegments);
        }
        continue;
      }

      const relativePath = entrySegments.join("/");
      if (
        (entry.isFile() || (entry.isSymbolicLink() && isFile(path.join(sourceRoot, ...entrySegments)))) &&
        matcher.match(relativePath)
      ) {
        matches.push(relativePath);
      }
    }
  };

  visit(literalPrefix);
  return matches;
};

const isAdditionalModuleRule = (rule: Record<string, any>) =>
  additionalModuleRuleTypes.has(rule.type) &&
  Array.isArray(rule.globs) &&
  rule.globs.every((glob) => typeof glob === "string");

const isHarnessInternalPath = (relativePath: string) => relativePath.split("/").includes(".btcf");

/**
 * Copies files matched by the config's module rules into the build output, so a `no_bundle` Worker can load modules
 * that Wrangler resolves relative to the original source tree. Earlier source roots win on path conflicts.
 */
export const copyAdditionalModules = ({
  outdir,
  rules,
  sourceRoots,
}: {
  outdir: string;
  rules: unknown;
  sourceRoots: string[];
}) => {
  const moduleRules = Array.isArray(rules) ? rules.filter(isAdditionalModuleRule) : [];
  const copiedRelativePaths = new Set<string>();
  const resolvedOutdir = path.resolve(outdir);

  for (const rule of moduleRules) {
    for (const glob of rule.globs as string[]) {
      if (path.isAbsolute(glob)) {
        continue;
      }

      for (const sourceRoot of sourceRoots) {
        for (const relativePath of findAdditionalModuleFiles(sourceRoot, glob)) {
          const sourcePath = path.resolve(sourceRoot, relativePath);
          if (
            copiedRelativePaths.has(relativePath) ||
            isHarnessInternalPath(relativePath) ||
            sourcePath === resolvedOutdir ||
            sourcePath.startsWith(`${resolvedOutdir}${path.sep}`)
          ) {
            continue;
          }

          const destinationPath = path.join(outdir, relativePath);
          mkdirSync(path.dirname(destinationPath), { recursive: true });
          try {
            copyFileSync(sourcePath, destinationPath);
          } catch (error) {
            if (isMissingPathError(error)) continue;
            throw error;
          }
          copiedRelativePaths.add(relativePath);
        }
      }
    }
  }
};
