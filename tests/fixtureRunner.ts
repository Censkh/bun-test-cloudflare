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

export const expectBunFixtureToPass = (
  fixtureRoot: string,
  options: { env?: NodeJS.ProcessEnv; logOutput?: boolean } = {},
) => {
  const start = performance.now();
  const packageJsonPath = path.join(fixtureRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const dependencySpecs = Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
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
      const stdout = installResult.stdout.toString();
      const stderr = installResult.stderr.toString();
      console.error(`[fixture:${path.basename(fixtureRoot)}] bun install failed`);
      if (stdout) console.error(stdout);
      if (stderr) console.error(stderr);
    }
    expect(installResult.exitCode).toBe(0);
  }

  const fixtureTests = findFixtureTests(fixtureRoot);
  expect(fixtureTests.length).toBeGreaterThan(0);

  const result = Bun.spawnSync({
    cmd: [process.execPath, "test", ...fixtureTests],
    cwd: fixtureRoot,
    env: { ...process.env, ...options.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const duration = performance.now() - start;

  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  if (options.logOutput || result.exitCode !== 0) {
    console.error(`[fixture:${path.basename(fixtureRoot)}] ${duration.toFixed(1)}ms`);
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
  }

  expect(result.exitCode).toBe(0);
};
