import { expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";

export const fixturePath = (testDir: string, fixtureName: string) => path.join(testDir, "fixtures", fixtureName);

const findFixtureTests = (fixtureRoot: string): string[] => {
  const fixtureTests: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") {
          continue;
        }
        visit(entryPath);
      } else if (/\.fixture\.tsx?$/.test(entry.name)) {
        fixtureTests.push(`./${path.relative(fixtureRoot, entryPath)}`);
      }
    }
  };

  visit(fixtureRoot);
  return fixtureTests.sort();
};

type BunFixtureResult = {
  durationMs: number;
  exitCode: number | null;
  stderr: string;
  stdout: string;
  expectStatusCode(expectedStatusCode: number): void;
};

const createBunFixtureResult = (
  fixtureRoot: string,
  result: Omit<BunFixtureResult, "expectStatusCode">,
): BunFixtureResult => ({
  ...result,
  expectStatusCode(expectedStatusCode: number) {
    if (result.exitCode !== expectedStatusCode) {
      console.error(`[fixture:${path.basename(fixtureRoot)}] expected exit code ${expectedStatusCode}`);
      console.error(`[fixture:${path.basename(fixtureRoot)}] actual exit code ${result.exitCode}`);
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
    }

    expect(result.exitCode).toBe(expectedStatusCode);
  },
});

export const runBunFixture = (
  fixtureRoot: string,
  options: { env?: NodeJS.ProcessEnv; logOutput?: boolean; testArgs?: string[]; timeoutMs?: number } = {},
) => {
  const start = performance.now();
  const packageJsonPath = path.join(fixtureRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const dependencySpecs = Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    if (packageJson.dependencies?.["bun-test-cloudflare"] || packageJson.devDependencies?.["bun-test-cloudflare"]) {
      return createBunFixtureResult(fixtureRoot, {
        durationMs: performance.now() - start,
        exitCode: 1,
        stderr: `${packageJsonPath} must not depend on bun-test-cloudflare; fixture tests should resolve the workspace package from the parent test process`,
        stdout: "",
      });
    }
    const hasFileDependency = dependencySpecs.some(
      (specifier) => typeof specifier === "string" && specifier.startsWith("file:"),
    );
    const installResult = Bun.spawnSync({
      cmd: hasFileDependency
        ? [process.execPath, "install", "--no-save"]
        : [process.execPath, "install", "--no-save", "--lockfile-only"],
      cwd: fixtureRoot,
      env: { ...process.env, ...options.env },
      stderr: "pipe",
      stdout: "pipe",
    });

    if (installResult.exitCode !== 0) {
      return createBunFixtureResult(fixtureRoot, {
        durationMs: performance.now() - start,
        exitCode: installResult.exitCode,
        stderr: installResult.stderr.toString(),
        stdout: installResult.stdout.toString(),
      });
    }
  }

  const fixtureTests = findFixtureTests(fixtureRoot);
  if (fixtureTests.length === 0) {
    return createBunFixtureResult(fixtureRoot, {
      durationMs: performance.now() - start,
      exitCode: 1,
      stderr: `No fixture tests found in ${fixtureRoot}`,
      stdout: "",
    });
  }

  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "test",
      ...(options.testArgs ?? []),
      ...fixtureTests,
      ...(options.timeoutMs ? ["--timeout", String(options.timeoutMs)] : []),
    ],
    cwd: fixtureRoot,
    env: { ...process.env, ...options.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const durationMs = performance.now() - start;
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  if (options.logOutput) {
    console.error(`[fixture:${path.basename(fixtureRoot)}] ${durationMs.toFixed(1)}ms`);
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
  }

  return createBunFixtureResult(fixtureRoot, { durationMs, exitCode: result.exitCode, stderr, stdout });
};
