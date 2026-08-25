import { beforeAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

export const fixturePath = (testDir: string, fixtureName: string) => path.join(testDir, "fixtures", fixtureName);

const packageRoot = path.resolve(import.meta.dir, "..");
const fixturePreparationLockTimeoutMs = 60_000;

type BunFixtureBeforeOptions = {
  env?: NodeJS.ProcessEnv;
  installMode?: "full" | "lockfile";
};

const preparedFixtureRoots = new Set<string>();

const sleepSync = (durationMs: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
};

const getFixturePackageLinkPath = (fixtureRoot: string) =>
  path.join(fixtureRoot, "node_modules", "bun-test-cloudflare");

const isFixturePrepared = (fixtureRoot: string) => fs.existsSync(getFixturePackageLinkPath(fixtureRoot));

const withFixturePreparationLock = <TResult>(fixtureRoot: string, callback: () => TResult) => {
  const lockPath = path.join(fixtureRoot, ".bun-test-cloudflare-prepare.lock");
  const deadline = Date.now() + fixturePreparationLockTimeoutMs;
  let lockFile: number | undefined;

  while (lockFile === undefined && Date.now() < deadline) {
    try {
      lockFile = fs.openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      sleepSync(25);
    }
  }

  if (lockFile === undefined) {
    throw new Error(`Timed out waiting for fixture preparation lock: ${lockPath}`);
  }

  try {
    fs.writeFileSync(lockFile, `${process.pid}\n`);
    return callback();
  } finally {
    fs.closeSync(lockFile);
    fs.unlinkSync(lockPath);
  }
};

const linkFixturePackage = (fixtureRoot: string) => {
  const nodeModulesPath = path.join(fixtureRoot, "node_modules");
  const packageLinkPath = getFixturePackageLinkPath(fixtureRoot);
  if (fs.existsSync(packageLinkPath)) return;

  fs.mkdirSync(nodeModulesPath, { recursive: true });
  fs.symlinkSync(packageRoot, packageLinkPath, "dir");
};

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

const prepareBunFixture = (fixtureRoot: string, options: BunFixtureBeforeOptions = {}) => {
  if (isFixturePrepared(fixtureRoot)) {
    return;
  }

  return withFixturePreparationLock(fixtureRoot, () => {
    if (isFixturePrepared(fixtureRoot)) {
      return;
    }

    const packageJsonPath = path.join(fixtureRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      linkFixturePackage(fixtureRoot);
      return;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const dependencySpecs = Object.values({
      ...packageJson.dependencies,
      ...packageJson.devDependencies,
    });
    if (packageJson.dependencies?.["bun-test-cloudflare"] || packageJson.devDependencies?.["bun-test-cloudflare"]) {
      throw new Error(
        `${packageJsonPath} must not depend on bun-test-cloudflare; fixture tests should resolve the workspace package from the parent test process`,
      );
    }

    const hasFileDependency = dependencySpecs.some(
      (specifier) => typeof specifier === "string" && specifier.startsWith("file:"),
    );
    const shouldInstallNodeModules = options.installMode === "full" || hasFileDependency;
    const installResult = Bun.spawnSync({
      cmd: shouldInstallNodeModules
        ? [process.execPath, "install", "--no-save"]
        : [process.execPath, "install", "--no-save", "--lockfile-only"],
      cwd: fixtureRoot,
      env: { ...process.env, ...options.env },
      stderr: "pipe",
      stdout: "pipe",
    });

    if (installResult.exitCode !== 0) {
      throw new Error(
        `Failed to install fixture dependencies for ${fixtureRoot}:\n${installResult.stderr.toString() || installResult.stdout.toString()}`,
      );
    }

    linkFixturePackage(fixtureRoot);
  });
};

const beforeBunFixture = (fixtureRoot: string, options: BunFixtureBeforeOptions = {}) => {
  const resolvedFixtureRoot = path.resolve(fixtureRoot);

  beforeAll(() => {
    prepareBunFixture(resolvedFixtureRoot, options);
    preparedFixtureRoots.add(resolvedFixtureRoot);
  });
};

type BunFixtureResult = {
  durationMs: number;
  exitCode: number | null;
  signalCode: string | null;
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
      console.error(`[fixture:${path.basename(fixtureRoot)}] signal ${result.signalCode}`);
      if (result.stdout) console.error(result.stdout);
      if (result.stderr) console.error(result.stderr);
    }

    expect(result.exitCode).toBe(expectedStatusCode);
  },
});

type BunFixtureRunOptions = {
  env?: NodeJS.ProcessEnv;
  fixtureTests?: string[];
  logOutput?: boolean;
  processTimeoutMs?: number;
  testArgs?: string[];
  timeoutMs?: number;
};

const getFixtureWranglerVersion = (fixtureRoot: string) => {
  try {
    const packageJsonPath = require.resolve("wrangler/package.json", { paths: [fixtureRoot] });
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return `${packageJson.version} (${packageJsonPath})`;
  } catch {
    return "unresolved";
  }
};

const runBunFixture = (fixtureRoot: string, options: BunFixtureRunOptions = {}) => {
  const start = performance.now();
  if (!preparedFixtureRoots.has(path.resolve(fixtureRoot))) {
    return createBunFixtureResult(fixtureRoot, {
      durationMs: performance.now() - start,
      exitCode: 1,
      signalCode: null,
      stderr: `Fixture ${fixtureRoot} was not prepared. Call beforeBunFixture() while defining the test suite.`,
      stdout: "",
    });
  }

  const fixtureTests = options.fixtureTests ?? findFixtureTests(fixtureRoot);
  if (fixtureTests.length === 0) {
    return createBunFixtureResult(fixtureRoot, {
      durationMs: performance.now() - start,
      exitCode: 1,
      signalCode: null,
      stderr: `No fixture tests found in ${fixtureRoot}`,
      stdout: "",
    });
  }

  const command = [
    process.execPath,
    "test",
    ...(options.testArgs ?? []),
    "--timeout",
    String(options.timeoutMs ?? 10_000),
    ...fixtureTests,
  ];
  const shouldLogOutput = options.logOutput || process.env.BUN_TEST_CLOUDFLARE_TIMINGS === "1";
  if (shouldLogOutput) {
    console.error(
      `[fixture:${path.basename(fixtureRoot)}] starting bun=${process.versions.bun} wrangler=${getFixtureWranglerVersion(fixtureRoot)}`,
    );
    console.error(`[fixture:${path.basename(fixtureRoot)}] command: ${command.join(" ")}`);
  }

  const result = Bun.spawnSync({
    cmd: command,
    cwd: fixtureRoot,
    env: { ...process.env, ...options.env },
    stderr: "pipe",
    stdout: "pipe",
    timeout: options.processTimeoutMs,
  });
  const durationMs = performance.now() - start;
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();
  const timedOut = options.processTimeoutMs !== undefined && durationMs >= options.processTimeoutMs;
  const exitCode = timedOut ? null : result.exitCode;
  const signalCode = timedOut ? (result.signalCode ?? "SIGTERM") : (result.signalCode ?? null);

  if (shouldLogOutput || exitCode === null) {
    console.error(
      `[fixture:${path.basename(fixtureRoot)}] finished in ${durationMs.toFixed(1)}ms exit=${exitCode} signal=${signalCode}`,
    );
    if (stdout) console.error(stdout);
    if (stderr) console.error(stderr);
  }

  return createBunFixtureResult(fixtureRoot, {
    durationMs,
    exitCode,
    signalCode,
    stderr,
    stdout,
  });
};

export const bunFixtureTest = (fixtureRoot: string, options: BunFixtureBeforeOptions = {}) => {
  beforeBunFixture(fixtureRoot, options);

  return {
    test(
      name: string,
      callback: (context: { run: (runOptions?: BunFixtureRunOptions) => BunFixtureResult }) => void | Promise<void>,
      timeout?: number,
    ) {
      return test(name, () => callback({ run: (runOptions) => runBunFixture(fixtureRoot, runOptions) }), timeout);
    },
  };
};
