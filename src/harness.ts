import { onTestFinished } from "bun:test";
import crypto from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { semver } from "bun";
import type { TestHarness, TestHarnessOptions, WorkerHandle } from "wrangler";
import { unstable_readConfig } from "wrangler";
import { copyAdditionalModules, getAdditionalModuleSourceRoots } from "./AdditionalModules";
import { canUseFencedWorkerSlots, createFencedWorkerSlots } from "./FencedWorkerSlots";
import {
  type CloudflareHarnessRunContext,
  getCloudflareHarnessRunContext,
  HarnessRun,
  type PreparedWorkerInput,
} from "./HarnessRun";
import {
  type CloudflareHarnessServeContext,
  type CloudflareHarnessServeOptions,
  type CloudflareHarnessServer,
  serveHarness,
  serveHarnessUntilExit,
  toNativeResponse,
} from "./HarnessServer";
import {
  closePrewarmedServerOrchestrators,
  PrewarmedServerOrchestrator,
  parkOrchestrator,
  takeParkedOrchestrator,
  WARM_WORKERD_POOL_SIZE,
} from "./PrewarmedServerOrchestrator";
import type { RunVariant } from "./ServerOrchestrator";
import { InlineServerOrchestrator, type ServerOrchestrator } from "./ServerOrchestrator";
import { SharedBrokerServerOrchestrator, shouldUseSharedSlotBroker } from "./SharedSlotBroker";
import { isInTest, onCreatingScopeEnd } from "./TestScope";
import { getWorkerBuildCacheDir, restoreCachedBuild, storeBuild } from "./WorkerBuildCache";
import { getWorkerBuildOutdir, isErrnoException, isProcessAlive, removeFinishedRunBuilds } from "./WorkerBuildOutput";
import { installWranglerPatches } from "./wranglerPatches";

type WorkerInput = TestHarnessOptions["workers"][number];
const DEFAULT_ISOLATED_WORKER_SLOTS = 4;

export type TypeToken<T> = {
  readonly __type?: T;
};

export const typeToken = <T>(): TypeToken<T> => ({});

export { WORKER_RUNTIME_CRASHED, WorkerRuntimeCrashError } from "./WorkerRuntimeCrash";
export { closePrewarmedServerOrchestrators };

export type CloudflareWorkerConfig<TBindings = Record<string, any>> = WorkerInput & {
  bindings?: TypeToken<TBindings>;
  name?: string;
};

export type CloudflareWorkerMap<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  [TKey in keyof TWorkers]: WorkerHandle<WorkerBindings<TWorkers[TKey]>>;
};

export type CloudflareHarnessConfig<TWorkers extends Record<string, CloudflareWorkerConfig>> = Omit<
  TestHarnessOptions,
  "workers"
> & {
  d1ResetMode?: "drop" | "truncate";
  events?: {
    beforeRun?: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<void> | void;
  };
  isolatedWorkerSlots?: number;
  prewarmedWorkerdPoolSize?: number;
  workers: TWorkers;
};

type CloudflareHarnessCallback<TWorkers extends Record<string, CloudflareWorkerConfig>, TResult> = (
  workers: CloudflareWorkerMap<TWorkers>,
  server: TestHarness,
) => Promise<TResult> | TResult;

/** One Worker slot held across several runs; see `CloudflareHarness.lease()`. */
export type CloudflareHarnessLease<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  /** Runs the callback in the leased slot. Runs never overlap: each waits for the one before. */
  run<TResult>(callback: CloudflareHarnessCallback<TWorkers, TResult>): Promise<TResult>;
  /** Waits for the last run, then returns the slot, which is reset before anything else uses it. */
  release(): Promise<void>;
};

/**
 * What a harness variant's runs set over its harness's config (`CloudflareHarness.with()`): only
 * what a run can change without different Workers.
 */
export type CloudflareHarnessVariant<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  /** Vars each Worker's code sees, by the Worker's key in `workers`, over its config's own. */
  vars?: { [TKey in keyof TWorkers]?: Record<string, string> };
  /**
   * Whether queue messages a run sends reach their consumers: for every Worker, or by consuming
   * Worker's key (`true` for one not named, and unless set).
   */
  consumeQueues?: boolean | { [TKey in keyof TWorkers]?: boolean };
};

export type CloudflareHarness<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  /**
   * The same Workers, with `variant`'s vars and settings for its runs. With isolated Worker slots
   * a variant shares its harness's runtimes, so a suite's one harness serves every test's variant
   * without starting workerd again; without slots, whose Workers read their vars as workerd
   * starts, it is a harness of its own. A variant of a variant has both, the later one's over
   * the earlier's.
   */
  with(variant: CloudflareHarnessVariant<TWorkers>): CloudflareHarness<TWorkers>;
  run<TResult>(callback: CloudflareHarnessCallback<TWorkers, TResult>): Promise<TResult>;
  /**
   * Leases one Worker slot for several runs, for example from `beforeAll` to `afterAll`, instead
   * of a fresh slot for each run. Runs in a lease share Worker globals and storage, so use it only
   * for tests that keep their data apart (for example, each in a project of its own). Each run
   * still waits for the background work it started and reports its waitUntil failures.
   */
  lease(): Promise<CloudflareHarnessLease<TWorkers>>;
  /** Exposes one worker over HTTP for the length of a run, e.g. as a backend for browser tests. */
  serve(options: CloudflareHarnessServeOptions<TWorkers>): Promise<CloudflareHarnessServer<TWorkers>>;
};

export {
  type CloudflareHarnessRunContext,
  type CloudflareHarnessServeContext,
  type CloudflareHarnessServeOptions,
  type CloudflareHarnessServer,
  getCloudflareHarnessRunContext,
  serveHarnessUntilExit,
  toNativeResponse,
};

installWranglerPatches();
const timingOrigin = performance.now();

const logTiming = (label: string, startedAt: number) => {
  if (process.env.BUN_TEST_CLOUDFLARE_TIMINGS !== "1") {
    return;
  }

  const now = performance.now();
  process.stderr.write(
    `[bun-test-cloudflare] +${(now - timingOrigin).toFixed(1)}ms ${label}: ${(now - startedAt).toFixed(1)}ms\n`,
  );
};

type WorkerBindings<TWorker> = TWorker extends { bindings?: TypeToken<infer TBindings> }
  ? TBindings
  : Record<string, any>;

const configPathToString = (configPath: string | URL) =>
  configPath instanceof URL ? fileURLToPath(configPath) : configPath;

const resolveConfigPath = (configPath: string | URL, root: string | undefined) => {
  const configPathString = configPathToString(configPath);
  return path.isAbsolute(configPathString) ? configPathString : path.resolve(root ?? process.cwd(), configPathString);
};

const withTestEnvironmentDefine = (config: Record<string, any>) => {
  const { triggers, ...testConfig } = config;
  return {
    ...testConfig,
    define: {
      ...config.define,
      "process.env.NODE_ENV": "'test'",
    },
    ...(triggers?.crons ? { triggers } : {}),
  };
};

const directoryContainsWasm = (directory: string): boolean =>
  readdirSync(directory, { withFileTypes: true }).some((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? directoryContainsWasm(entryPath) : /\.wasm(?:\?module)?$/.test(entry.name);
  });

const withDryRunModuleRules = (rules: Array<Record<string, any>> | undefined, outdir: string) => {
  const configuredRules = rules ?? [];
  if (configuredRules.some((rule) => rule.type === "CompiledWasm") || !directoryContainsWasm(outdir)) {
    return configuredRules;
  }
  return [...configuredRules, { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] }];
};

const withDryRunBuildConfig = (config: Record<string, any>) => ({
  ...config,
  find_additional_modules: false,
});

const getWranglerBinPath = () => {
  const wranglerPackageJsonPath = fileURLToPath(import.meta.resolve("wrangler/package.json"));
  const wranglerPackageJson = JSON.parse(readFileSync(wranglerPackageJsonPath, "utf8")) as {
    bin?: { wrangler?: string };
  };
  return path.join(path.dirname(wranglerPackageJsonPath), wranglerPackageJson.bin?.wrangler ?? "bin/wrangler.js");
};

const getWranglerPreloadArgs = () =>
  (process.env.BUN_TEST_CLOUDFLARE_WRANGLER_PRELOADS ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap((preloadPath) => ["--preload", preloadPath]);

const sleepSync = (durationMs: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
};

const getPositiveIntegerEnvironmentVariable = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

const getNonNegativeIntegerEnvironmentVariable = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
};

const buildInitializationTimeoutMs = getPositiveIntegerEnvironmentVariable(
  "BUN_TEST_CLOUDFLARE_BUILD_TIMEOUT_MS",
  30_000,
);
const buildOperationTimeoutMs = getPositiveIntegerEnvironmentVariable(
  "BUN_TEST_CLOUDFLARE_BUILD_OPERATION_TIMEOUT_MS",
  30_000,
);
const buildRetryCount = getNonNegativeIntegerEnvironmentVariable("BUN_TEST_CLOUDFLARE_BUILD_RETRY_COUNT", 1);
const buildRetryDelayMs = getPositiveIntegerEnvironmentVariable("BUN_TEST_CLOUDFLARE_BUILD_RETRY_DELAY_MS", 250);

const getRemainingBuildTimeMs = (deadline: number) => Math.max(0, deadline - Date.now());
const getBuildOperationTimeoutMs = (deadline: number) =>
  Math.min(buildOperationTimeoutMs, getRemainingBuildTimeMs(deadline));

export const removeStaleBuildLock = (lockPath: string) => {
  try {
    const ownerProcessId = Number(readFileSync(lockPath, "utf8").trim());
    if (!Number.isSafeInteger(ownerProcessId) || ownerProcessId <= 0 || isProcessAlive(ownerProcessId)) {
      return false;
    }
    unlinkSync(lockPath);
    return true;
  } catch (error) {
    if (isErrnoException(error) && error.code === "ENOENT") {
      return true;
    }
    return false;
  }
};

type WorkerBuildStatus =
  | {
      buildKey: string;
      builtMain: string;
      state: "success";
    }
  | {
      buildKey: string;
      errorMessage: string;
      errorStack?: string;
      state: "failure";
    }
  | {
      buildKey: string;
      ownerPid: number;
      state: "building";
    };

type WorkerBuildResult = {
  built: boolean;
  builtMain: string;
};

export type WorkerBuildPlan = {
  additionalModuleSourceRoots: string[];
  buildBaseDirectory: string;
  buildCwd: string;
  buildKey: string;
  config: Record<string, any>;
  env: string | undefined;
  outdir: string;
  statusPath: string;
  testConfig: Record<string, any>;
  workerName: string;
};

const getBunTestRunKey = () =>
  process.env.BUN_TEST_WORKER_ID === undefined && process.env.JEST_WORKER_ID === undefined
    ? String(process.pid)
    : String(process.ppid);

const getBuildStatusPath = (outdir: string) => `${outdir}.status.json`;

const createBuildKey = (config: Record<string, any>, env: string | undefined, buildCwd: string) =>
  crypto.createHash("sha256").update(JSON.stringify({ buildCwd, config, env })).digest("hex");

const writeBuildStatus = (statusPath: string, status: WorkerBuildStatus) => {
  writeFileSync(statusPath, JSON.stringify(status));
};

const readBuildStatus = (statusPath: string): WorkerBuildStatus | undefined => {
  try {
    return JSON.parse(readFileSync(statusPath, "utf8")) as WorkerBuildStatus;
  } catch {
    return undefined;
  }
};

const serializeBuildError = (error: unknown) => ({
  errorMessage: error instanceof Error ? error.message : String(error),
  ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
});

const throwBuildFailure = (status: Extract<WorkerBuildStatus, { state: "failure" }>) => {
  const error = new Error(status.errorMessage);
  if (status.errorStack) {
    error.stack = status.errorStack;
  }
  throw error;
};

const withBuildLock = <TResult>(outdir: string, deadline: number, callback: () => TResult) => {
  const lockPath = `${outdir}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  let lockFile: number | undefined;
  for (let attempt = 0; lockFile === undefined && attempt <= buildRetryCount; attempt++) {
    const attemptDeadline = Date.now() + getBuildOperationTimeoutMs(deadline);
    while (lockFile === undefined && getRemainingBuildTimeMs(attemptDeadline) > 0) {
      try {
        lockFile = openSync(lockPath, "wx");
        writeFileSync(lockFile, `${process.pid}\n`);
        closeSync(lockFile);
      } catch (error) {
        if (!isErrnoException(error) || error.code !== "EEXIST") {
          throw error;
        }
        if (removeStaleBuildLock(lockPath)) {
          continue;
        }
        sleepSync(50);
      }
    }

    if (lockFile === undefined && attempt < buildRetryCount && getRemainingBuildTimeMs(deadline) > 0) {
      sleepSync(Math.min(buildRetryDelayMs, getRemainingBuildTimeMs(deadline)));
    }
  }

  if (lockFile === undefined) {
    throw new Error(`Timed out waiting for worker build lock after ${buildInitializationTimeoutMs}ms: ${lockPath}`);
  }

  const releaseLock = () => {
    try {
      unlinkSync(lockPath);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  };

  try {
    const result = callback();
    releaseLock();
    return result;
  } catch (error) {
    releaseLock();
    throw error;
  }
};

const runWranglerDryRun = (
  configPath: string,
  outdir: string,
  env: string | undefined,
  deadline: number,
  cwd: string,
  metafilePath: string,
) => {
  mkdirSync(outdir, { recursive: true });
  const wranglerBinPath = getWranglerBinPath();
  const args = [
    wranglerBinPath,
    "deploy",
    "--dry-run",
    "--outdir",
    outdir,
    "--config",
    configPath,
    "--metafile",
    metafilePath,
  ];
  if (env) {
    args.push("--env", env);
  }

  for (let attempt = 0; attempt <= buildRetryCount; attempt++) {
    const timeout = getBuildOperationTimeoutMs(deadline);
    if (timeout <= 0) {
      break;
    }

    const result = Bun.spawnSync({
      cmd: [process.execPath, ...getWranglerPreloadArgs(), ...args],
      cwd,
      stderr: "pipe",
      stdout: "pipe",
      timeout,
    });
    const stdout = result.stdout.toString();
    const stderr = result.stderr.toString();

    const timedOut = result.signalCode === "SIGTERM";
    if (!timedOut && result.exitCode === 0) {
      return;
    }

    if (timedOut && attempt < buildRetryCount && getRemainingBuildTimeMs(deadline) > 0) {
      sleepSync(Math.min(buildRetryDelayMs, getRemainingBuildTimeMs(deadline)));
      continue;
    }

    throw new Error(
      [
        timedOut
          ? `wrangler deploy --dry-run timed out after ${timeout}ms for ${configPath}`
          : `wrangler deploy --dry-run failed for ${configPath}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
        stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }

  throw new Error(`wrangler deploy --dry-run timed out after ${buildInitializationTimeoutMs}ms for ${configPath}`);
};

const createWorkerBuildPlan = (
  workerName: string,
  buildBaseDirectory: string,
  buildCwd: string,
  testConfig: Record<string, any>,
  config: Record<string, any>,
  env: string | undefined,
  additionalModuleSourceRoots: string[],
): WorkerBuildPlan => {
  const buildKey = createBuildKey(testConfig, env, buildCwd);
  const outdir = getWorkerBuildOutdir(buildBaseDirectory, getBunTestRunKey(), workerName, buildKey);
  return {
    additionalModuleSourceRoots,
    buildBaseDirectory,
    buildCwd,
    buildKey,
    config,
    env,
    outdir,
    statusPath: getBuildStatusPath(outdir),
    testConfig,
    workerName,
  };
};

/** What else decides a build's output besides its plan: Wrangler's version and the patches applied to it. */
let buildToolKey: string | undefined;
const getBuildToolKey = () => {
  if (buildToolKey !== undefined) return buildToolKey;
  const hash = crypto.createHash("sha256");
  const wranglerPackage = path.join(path.dirname(getWranglerBinPath()), "..", "package.json");
  if (existsSync(wranglerPackage)) hash.update(readFileSync(wranglerPackage));
  const patches = [path.join(import.meta.dir, "wranglerPatches.ts"), path.join(import.meta.dir, "patches")];
  const addFiles = (file: string) => {
    if (!existsSync(file)) return;
    if (statSync(file).isDirectory()) {
      for (const entry of readdirSync(file).sort()) addFiles(path.join(file, entry));
    } else hash.update(file).update(readFileSync(file));
  };
  for (const file of patches) addFiles(file);
  buildToolKey = hash.digest("hex");
  return buildToolKey;
};

/**
 * Finishes this run's build of `plan` from the cache of earlier runs (WorkerBuildCache) when its inputs
 * are unchanged, without starting Wrangler; `undefined` when there is none to use. Loading Wrangler, as
 * a build process does, takes about a second, which a run that only restores builds skips.
 */
export const restoreWorkerBuild = (plan: WorkerBuildPlan): WorkerBuildResult | undefined => {
  const deadline = Date.now() + buildInitializationTimeoutMs;
  return withBuildLock(plan.outdir, deadline, () => {
    const existingStatus = readBuildStatus(plan.statusPath);
    if (
      existingStatus?.buildKey === plan.buildKey &&
      existingStatus.state === "success" &&
      existsSync(existingStatus.builtMain)
    )
      return { built: false, builtMain: existingStatus.builtMain };
    const cacheDir = getWorkerBuildCacheDir(plan.buildBaseDirectory, plan.buildKey, getBuildToolKey());
    if (!restoreCachedBuild(cacheDir, plan.outdir)) return undefined;
    return finishWorkerBuild(plan);
  });
};

/** A dry run's output in `plan.outdir` made ready to serve: its main module named, its additional modules beside it. */
const finishWorkerBuild = (plan: WorkerBuildPlan): WorkerBuildResult => {
  const builtMain = normalizeBuiltMain(plan.outdir, findBuiltMain(plan.outdir, plan.config.main));
  copyAdditionalModules({
    outdir: plan.outdir,
    rules: plan.config.rules,
    sourceRoots: plan.additionalModuleSourceRoots,
  });
  writeBuildStatus(plan.statusPath, { buildKey: plan.buildKey, builtMain, state: "success" });
  return { built: true, builtMain };
};

export const buildWorkerOnce = (plan: WorkerBuildPlan): WorkerBuildResult => {
  const deadline = Date.now() + buildInitializationTimeoutMs;
  removeFinishedRunBuilds(plan.buildBaseDirectory, isProcessAlive);
  return withBuildLock(plan.outdir, deadline, () => {
    const existingStatus = readBuildStatus(plan.statusPath);
    if (existingStatus?.buildKey === plan.buildKey) {
      if (existingStatus.state === "success" && existsSync(existingStatus.builtMain)) {
        return { built: false, builtMain: existingStatus.builtMain };
      }
      if (existingStatus.state === "failure") {
        throwBuildFailure(existingStatus);
      }
    }

    // Only leftovers from an earlier run with a reused process ID or a crashed build can be here.
    rmSync(plan.outdir, { force: true, recursive: true });
    mkdirSync(plan.outdir, { recursive: true });
    writeBuildStatus(plan.statusPath, { buildKey: plan.buildKey, ownerPid: process.pid, state: "building" });
    try {
      // A build an earlier run made from the same inputs is reused (WorkerBuildCache).
      const cacheDir = getWorkerBuildCacheDir(plan.buildBaseDirectory, plan.buildKey, getBuildToolKey());
      if (!restoreCachedBuild(cacheDir, plan.outdir)) {
        const testConfigPath = writeResolvedConfig(plan.outdir, withDryRunBuildConfig(plan.testConfig));
        const metafilePath = `${plan.outdir}.meta.json`;
        runWranglerDryRun(testConfigPath, plan.outdir, plan.env, deadline, plan.buildCwd, metafilePath);
        storeBuild(cacheDir, plan.outdir, metafilePath, [plan.buildCwd, path.dirname(testConfigPath)]);
      }
      return finishWorkerBuild(plan);
    } catch (error) {
      writeBuildStatus(plan.statusPath, {
        buildKey: plan.buildKey,
        state: "failure",
        ...serializeBuildError(error),
      });
      throw error;
    }
  });
};

const findBuiltMain = (outdir: string, originalMain: string | undefined) => {
  if (originalMain) {
    const expectedBuiltMain = path.join(outdir, `${path.basename(originalMain, path.extname(originalMain))}.js`);
    const builtFiles = readdirSync(outdir);
    if (builtFiles.includes(path.basename(expectedBuiltMain))) {
      return expectedBuiltMain;
    }
  }

  const builtMain = readdirSync(outdir).find((file) => file.endsWith(".js"));
  if (!builtMain) {
    throw new Error(`Wrangler dry-run did not emit a JavaScript entrypoint in ${outdir}`);
  }

  return path.join(outdir, builtMain);
};

const normalizeBuiltMain = (outdir: string, builtMain: string) => {
  const workerMain = path.join(outdir, "worker.js");
  if (builtMain !== workerMain) {
    copyFileSync(builtMain, workerMain);
  }

  return workerMain;
};

const writeResolvedConfig = (outdir: string, config: Record<string, any>) => {
  const configPath = path.join(outdir, "wrangler.json");
  mkdirSync(outdir, { recursive: true });
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
};

const resolveInlineConfig = (input: Extract<WorkerInput, { config: unknown }>, root: string | undefined) => {
  const config = input.config as Record<string, any>;
  const resolvedMain =
    typeof config.main === "string" && !path.isAbsolute(config.main)
      ? path.resolve(root ?? process.cwd(), config.main)
      : config.main;
  const resolvedConfig = {
    ...config,
    ...(resolvedMain ? { main: resolvedMain } : {}),
  };
  return {
    additionalModuleSourceRoots: getAdditionalModuleSourceRoots(
      typeof resolvedMain === "string" ? path.dirname(resolvedMain) : undefined,
      root ?? process.cwd(),
    ),
    buildBaseDirectory: path.resolve(root ?? process.cwd()),
    buildCwd: path.resolve(root ?? process.cwd()),
    config: resolvedConfig,
  };
};

const resolveConfigPaths = (config: Record<string, any>, configDirectory: string): Record<string, any> => {
  const resolvePath = (value: unknown) =>
    typeof value === "string" && !path.isAbsolute(value) ? path.resolve(configDirectory, value) : value;

  return {
    ...config,
    ...(config.main ? { main: resolvePath(config.main) } : {}),
    ...(config.tsconfig ? { tsconfig: resolvePath(config.tsconfig) } : {}),
    ...(config.assets && typeof config.assets === "object" && config.assets.directory
      ? {
          assets: {
            ...config.assets,
            directory: resolvePath(config.assets.directory),
          },
        }
      : {}),
  };
};

const resolveWorkerConfig = (input: WorkerInput, root: string | undefined) => {
  if ("configPath" in input) {
    const { configPath, env } = input;
    const resolvedConfigPath = resolveConfigPath(configPath, root);
    const configDirectory = path.dirname(resolvedConfigPath);
    const config = resolveConfigPaths(
      unstable_readConfig({ config: resolvedConfigPath, ...(env ? { env } : {}) }, { hideWarnings: true }),
      configDirectory,
    );
    return {
      additionalModuleSourceRoots: getAdditionalModuleSourceRoots(
        typeof config.base_dir === "string" ? resolveConfigPath(config.base_dir, configDirectory) : undefined,
        configDirectory,
        root,
        process.cwd(),
      ),
      buildBaseDirectory: configDirectory,
      buildCwd: configDirectory,
      config,
    };
  }

  return resolveInlineConfig(input, root);
};

const planWorkerInput = (key: string, worker: CloudflareWorkerConfig, root: string | undefined) => {
  const start = performance.now();
  const { bindings: _bindings, name: _name, ...input } = worker;

  const vars = "vars" in input ? input.vars : undefined;
  const secrets = "secrets" in input ? input.secrets : undefined;
  const env = "env" in input ? input.env : undefined;
  const {
    additionalModuleSourceRoots,
    buildBaseDirectory,
    buildCwd,
    config: resolvedConfig,
  } = resolveWorkerConfig(input, root);
  const config = resolvedConfig as Record<string, any>;
  const workerName = worker.name ?? config.name ?? key;
  const testConfig = withTestEnvironmentDefine(config);
  const buildPlan = createWorkerBuildPlan(
    workerName,
    buildBaseDirectory,
    buildCwd,
    testConfig,
    config,
    env,
    additionalModuleSourceRoots,
  );
  const configPath = "configPath" in input ? resolveConfigPath(input.configPath, root) : undefined;
  return { start, vars, secrets, testConfig, workerName, buildPlan, configPath };
};

// Wrangler 4.121 added prebuiltWorkerDir for config-file inputs.
const supportsPrebuiltWorkerDir = semver.satisfies(require("wrangler/package.json").version, ">=4.121.0");

const prepareWorkerInput = (
  { start, vars, secrets, testConfig, workerName, buildPlan, configPath }: ReturnType<typeof planWorkerInput>,
  buildResult: WorkerBuildResult,
): PreparedWorkerInput => {
  const browserConfig = (testConfig as Record<string, unknown>).browser;
  const browserBindingName =
    typeof browserConfig === "object" &&
    browserConfig !== null &&
    "binding" in browserConfig &&
    typeof browserConfig.binding === "string"
      ? browserConfig.binding
      : undefined;

  const configuredRules = buildPlan.config.rules ?? [];
  const rules = withDryRunModuleRules(configuredRules, buildPlan.outdir);
  // Wrangler reads the original config and derives the emitted filename from its main. Keep our
  // resolved inline config when the build needs extra Wasm rules or a differently named entry.
  const main = buildPlan.config.main;
  const nativeMain = main && (buildPlan.config.no_bundle ? path.basename(main) : `${path.parse(main).name}.js`);
  const prebuiltInput =
    configPath &&
    supportsPrebuiltWorkerDir &&
    rules === configuredRules &&
    nativeMain &&
    existsSync(path.join(buildPlan.outdir, nativeMain))
      ? { configPath, env: buildPlan.env, prebuiltWorkerDir: buildPlan.outdir, vars, secrets }
      : undefined;
  return {
    prebuiltInput,
    browserBindingName,
    built: buildResult.built,
    durationMs: performance.now() - start,
    hasBrowserRendering: browserBindingName !== undefined,
    input: {
      config: {
        ...testConfig,
        base_dir: buildPlan.outdir,
        find_additional_modules: true,
        main: buildResult.builtMain,
        no_bundle: true,
        rules,
      },
      ...(vars ? { vars } : {}),
      ...(secrets ? { secrets } : {}),
    } as WorkerInput,
    name: workerName,
  };
};

/**
 * A finished build of this plan from the current `bun test` run. A success status never changes
 * for its build key, so it can be read without the build lock.
 */
const readFinishedBuild = (plan: WorkerBuildPlan): WorkerBuildResult | undefined => {
  const status = readBuildStatus(plan.statusPath);
  return status?.buildKey === plan.buildKey && status.state === "success" && existsSync(status.builtMain)
    ? { built: false, builtMain: status.builtMain }
    : undefined;
};

const buildWorkers = (plans: WorkerBuildPlan[]): WorkerBuildResult[] => {
  // Custom build commands can write to shared project files, so retain their original order.
  if (plans.length < 2 || plans.some((plan) => plan.config.build?.command)) {
    return plans.map(buildWorkerOnce);
  }
  // Every test file after the first finds its Workers built: reading their status here saves
  // starting a build process (and one per Worker, each loading Wrangler) just to read it.
  const finished = plans.map(readFinishedBuild);
  if (finished.every((result) => result !== undefined)) {
    return finished as WorkerBuildResult[];
  }
  // Or restore them from an earlier run's builds here, when every one is cached, rather than starting a
  // build process for it.
  const restored = plans.map((plan, index) => finished[index] ?? restoreWorkerBuild(plan));
  if (restored.every((result) => result !== undefined)) {
    return restored as WorkerBuildResult[];
  }
  const directory = mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-builds-"));
  try {
    const inputPath = path.join(directory, "plans.json");
    const outputPath = path.join(directory, "results.json");
    writeFileSync(inputPath, JSON.stringify(plans), { mode: 0o600 });
    const result = Bun.spawnSync({
      cmd: [process.execPath, path.join(import.meta.dir, "WorkerBuildProcess.ts"), inputPath, outputPath],
      stdout: "pipe",
      stderr: "pipe",
      timeout: buildInitializationTimeoutMs + 10_000,
    });
    if (result.exitCode !== 0 || result.signalCode) {
      throw new Error(`Parallel Worker builds failed: ${result.stderr.toString()}`);
    }
    const results = JSON.parse(readFileSync(outputPath, "utf8")) as Array<
      { result: WorkerBuildResult } | { errorMessage: string; errorStack?: string }
    >;
    return results.map((entry) => {
      if ("result" in entry) return entry.result;
      const error = new Error(entry.errorMessage);
      if (entry.errorStack) error.stack = entry.errorStack;
      throw error;
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
};

const functionIds = new WeakMap<Function, number>();
let nextFunctionId = 0;

/**
 * What decides a harness's runtimes: its config, with each function (an `events` hook) by identity,
 * so only a harness made from the same module-level hooks matches. Undefined when the config can't
 * be compared (it holds a cycle).
 */
const harnessReuseKey = (config: unknown) => {
  try {
    return JSON.stringify(config, (_key, value: unknown) => {
      if (typeof value !== "function") return value;
      let id = functionIds.get(value);
      if (id === undefined) functionIds.set(value, (id = nextFunctionId++));
      return `function#${id}`;
    });
  } catch {
    return undefined;
  }
};

export const createCloudflareHarness = <const TWorkers extends Record<string, CloudflareWorkerConfig>>(
  config: CloudflareHarnessConfig<TWorkers>,
): CloudflareHarness<TWorkers> => {
  const {
    d1ResetMode,
    events,
    isolatedWorkerSlots: configuredIsolatedWorkerSlots,
    prewarmedWorkerdPoolSize = WARM_WORKERD_POOL_SIZE,
    workers: workerConfigs,
    ...serverConfig
  } = config;
  if (
    configuredIsolatedWorkerSlots !== undefined &&
    (!Number.isInteger(configuredIsolatedWorkerSlots) || configuredIsolatedWorkerSlots < 1)
  ) {
    throw new TypeError("isolatedWorkerSlots must be a positive integer");
  }
  if (!Number.isInteger(prewarmedWorkerdPoolSize) || prewarmedWorkerdPoolSize < 1) {
    throw new TypeError("prewarmedWorkerdPoolSize must be a positive integer");
  }
  const workerEntries = Object.entries(workerConfigs) as Array<[keyof TWorkers, CloudflareWorkerConfig]>;
  const buildStartedAt = performance.now();
  let workerPlans: ReturnType<typeof planWorkerInput>[] | undefined;
  try {
    workerPlans = workerEntries.map(([key, worker]) => planWorkerInput(String(key), worker, serverConfig.root));
  } catch {
    // A preceding custom build may create a later Worker's config or entrypoint.
  }
  const preparedWorkers =
    !workerPlans || workerPlans.some((worker) => worker.buildPlan.config.build?.command)
      ? workerEntries.map(([key, worker]) => {
          const plan = planWorkerInput(String(key), worker, serverConfig.root);
          return prepareWorkerInput(plan, buildWorkerOnce(plan.buildPlan));
        })
      : (() => {
          const buildResults = buildWorkers(workerPlans.map((worker) => worker.buildPlan));
          return workerPlans.map((worker, index) => prepareWorkerInput(worker, buildResults[index]!));
        })();
  logTiming("worker builds", buildStartedAt);
  const supportsIsolatedWorkerSlots =
    configuredIsolatedWorkerSlots === 1 ? false : canUseFencedWorkerSlots(preparedWorkers);
  // A slot count is the most a harness runs at once: Workers a slot can't host (containers,
  // Workflows, bindings a fenced slot doesn't proxy) run in one runtime, as they always could.
  const isolatedWorkerSlots = supportsIsolatedWorkerSlots
    ? (configuredIsolatedWorkerSlots ?? DEFAULT_ISOLATED_WORKER_SLOTS)
    : 1;

  const hasBrowserRendering = preparedWorkers.some((worker) => worker.hasBrowserRendering);
  const keepsServerAlive = process.env.BUN_TEST_CLOUDFLARE_DISABLE_SERVER_PREWARM !== "1";
  const sharedBrokerConfigKey =
    isolatedWorkerSlots > 1 && keepsServerAlive && shouldUseSharedSlotBroker()
      ? (() => {
          try {
            // Vars aren't the broker's: each lease sends its slot the leasing process's (a URL of a
            // server that process started, say), so processes whose Workers differ only in them
            // share one broker.
            return JSON.stringify({
              d1ResetMode: d1ResetMode ?? "drop",
              serverConfig,
              workers: preparedWorkers.map((worker) => ({ input: withoutVars(worker.input), name: worker.name })),
            });
          } catch {
            return undefined;
          }
        })()
      : undefined;

  const fencedSlots =
    isolatedWorkerSlots > 1 && !sharedBrokerConfigKey
      ? createFencedWorkerSlots(preparedWorkers, isolatedWorkerSlots, { d1ResetMode })
      : undefined;

  const testHarnessOptions = {
    ...serverConfig,
    workers: fencedSlots?.inputs ?? preparedWorkers.map((worker) => worker.prebuiltInput ?? worker.input),
  };
  const createRun = () =>
    new HarnessRun({
      events,
      fencedSlots,
      hasBrowserRendering,
      preparedWorkers,
      testHarnessOptions,
      workerEntries,
    });
  // The Workers are built now, so building never counts against a test's timeout, but workerd starts
  // on the first run: a module can create a harness that a test file importing it never runs.
  let orchestrator: ServerOrchestrator<TWorkers> | undefined;
  // A harness made with the same config as one whose scope has ended (a later test file calling the
  // same shared factory) takes over its pool: its runtimes are reset between files as they are
  // between tests, rather than every file starting workerd again. The config is compared when the
  // pool is needed, as its runtimes read it then: a test may fill in a value (a URL it starts) after
  // creating the harness.
  let orchestratorKey: string | undefined;
  const getOrchestrator = () => {
    // The run-wide cleanup may have closed it while this harness, from a module later files share,
    // still held it.
    if (orchestrator?.closed) orchestrator = undefined;
    if (!orchestrator) {
      orchestratorKey = keepsServerAlive ? harnessReuseKey(config) : undefined;
      orchestrator =
        takeParkedOrchestrator<TWorkers>(orchestratorKey) ??
        (sharedBrokerConfigKey
          ? new SharedBrokerServerOrchestrator({
              d1ResetMode,
              events,
              isolatedWorkerSlots,
              orchestratorKey: sharedBrokerConfigKey,
              preparedWorkers,
              serverConfig,
              workerEntries,
            })
          : keepsServerAlive
            ? new PrewarmedServerOrchestrator(createRun, prewarmedWorkerdPoolSize)
            : new InlineServerOrchestrator(createRun));
    }
    return orchestrator;
  };
  // Bun keeps one process, and one module cache, across all the test files it runs, so a pool
  // otherwise lives until the whole run ends: every harness a file, describe block or test creates
  // would keep its workerd processes running through every later file. The pool closes when the
  // scope that created the harness ends instead; a harness used again later, such as one a shared
  // module creates while the first file imports it, starts a new pool on its next run. A harness
  // created in a `beforeAll` (or outside any test scope) keeps its pool until the run-wide cleanup
  // in the setup preload, and closes its idle prewarmed servers while other harnesses take leases.
  onCreatingScopeEnd(async () => {
    const current = orchestrator;
    orchestrator = undefined;
    if (current && !parkOrchestrator(orchestratorKey, current)) await current.close();
  });

  const usesSlots = fencedSlots !== undefined || sharedBrokerConfigKey !== undefined;
  /** The harness's lease, given the variant's vars and settings before any of its code runs. */
  const acquire = (variant: CloudflareHarnessVariant<TWorkers> | undefined) =>
    getOrchestrator().acquire(variant && toRunVariant(variant, workerEntries, preparedWorkers));
  const createHandle = (variant: CloudflareHarnessVariant<TWorkers> | undefined): CloudflareHarness<TWorkers> => {
    const handle: CloudflareHarness<TWorkers> = {
      with(next) {
        const merged = mergeVariants(variant, next);
        return usesSlots ? createHandle(merged) : createCloudflareHarness(applyVariant(config, merged));
      },
      serve(options) {
        return serveHarness(handle, options);
      },
      ...createRunMethods(variant),
    };
    return handle;
  };
  const createRunMethods = (
    variant: CloudflareHarnessVariant<TWorkers> | undefined,
  ): Pick<CloudflareHarness<TWorkers>, "lease" | "run"> => ({
    async lease() {
      const acquireStartedAt = performance.now();
      const lease = await acquire(variant);
      logTiming("harness lease acquire", acquireStartedAt);
      let released = false;
      let previous: Promise<unknown> = Promise.resolve();
      return {
        run(callback) {
          if (released) {
            return Promise.reject(new Error("Cloudflare harness lease is released"));
          }
          const result = previous.then(async () => {
            const runStartedAt = performance.now();
            try {
              return await lease.run.execute(callback, { closeAfterExecute: false });
            } finally {
              await lease.run.settle();
              logTiming("harness lease run", runStartedAt);
            }
          });
          previous = result.catch(() => {});
          return result;
        },
        async release() {
          if (released) return;
          released = true;
          await previous;
          await lease.release();
        },
      };
    },
    async run(callback) {
      const runStartedAt = performance.now();
      // A run its test doesn't wait for (the test timed out) ends with the test: its slot goes back
      // for the tests after it, and its own later calls fail as a finished run's. Held on, it would
      // keep a slot the other test processes sharing a broker wait for. Registered before the run
      // is acquired, which can outlast its test (a broker starting on a loaded machine), and only
      // in a test: Bun runs one a beforeAll registers as that hook ends, and a run a hook or a
      // script starts ends when its callback does.
      let testEnded = false;
      let release: (() => Promise<void>) | undefined;
      if (isInTest()) {
        try {
          onTestFinished(() => {
            testEnded = true;
            // What its release reports (a waitUntil failure) is the run's to throw, if it still can.
            return release?.().catch(() => {});
          });
        } catch {}
      }
      const acquireStartedAt = performance.now();
      const lease = await acquire(variant);
      logTiming("harness acquire", acquireStartedAt);
      let released: Promise<void> | undefined;
      release = () => {
        released ??= lease.release();
        return released;
      };
      if (testEnded) {
        await release().catch(() => {});
        const error = new Error("Cloudflare harness run's test ended before the run started");
        error.name = "CloudflareHarnessRunEnded";
        throw error;
      }
      try {
        return await lease.run.execute(callback, { closeAfterExecute: !keepsServerAlive });
      } finally {
        const releaseStartedAt = performance.now();
        await release();
        logTiming("harness release", releaseStartedAt);
        logTiming("harness run", runStartedAt);
      }
    },
  });
  return createHandle(undefined);
};

/** A Worker input without its vars and secrets, which each run gives its slot. */
const withoutVars = (input: unknown) => {
  const { secrets: _secrets, vars: _vars, ...rest } = input as { secrets?: unknown; vars?: unknown; config?: unknown };
  if (rest.config && typeof rest.config === "object") {
    const { vars: _configVars, ...config } = rest.config as { vars?: unknown };
    return { ...rest, config };
  }
  return rest;
};

const mergeVariants = <TWorkers extends Record<string, CloudflareWorkerConfig>>(
  earlier: CloudflareHarnessVariant<TWorkers> | undefined,
  later: CloudflareHarnessVariant<TWorkers>,
): CloudflareHarnessVariant<TWorkers> => {
  const vars: Record<string, Record<string, string>> = { ...(earlier?.vars as Record<string, Record<string, string>>) };
  for (const [key, overrides] of Object.entries(later.vars ?? {}))
    vars[key] = { ...vars[key], ...(overrides as Record<string, string>) };
  return {
    vars: vars as CloudflareHarnessVariant<TWorkers>["vars"],
    consumeQueues:
      typeof later.consumeQueues === "object" && typeof earlier?.consumeQueues === "object"
        ? { ...earlier.consumeQueues, ...later.consumeQueues }
        : (later.consumeQueues ?? earlier?.consumeQueues),
  };
};

/** A variant as its runs' slots take it: vars by Worker name. */
const toRunVariant = <TWorkers extends Record<string, CloudflareWorkerConfig>>(
  variant: CloudflareHarnessVariant<TWorkers>,
  workerEntries: Array<[keyof TWorkers, CloudflareWorkerConfig]>,
  preparedWorkers: Array<{ name: string }>,
): RunVariant => ({
  vars: Object.fromEntries(
    workerEntries.flatMap(([key], index) => {
      const vars = variant.vars?.[key];
      return vars ? [[preparedWorkers[index]!.name, vars]] : [];
    }),
  ),
  settings: {
    consumeQueues:
      typeof variant.consumeQueues === "object"
        ? Object.fromEntries(
            workerEntries.flatMap(([key], index) => {
              const consume = (variant.consumeQueues as Partial<Record<keyof TWorkers, boolean>>)[key];
              return consume === undefined ? [] : [[preparedWorkers[index]!.name, consume]];
            }),
          )
        : (variant.consumeQueues ?? true),
  },
});

/** Whether a variant's runs consume the queues of the Worker under `key`. */
const consumesQueues = <TWorkers extends Record<string, CloudflareWorkerConfig>>(
  variant: CloudflareHarnessVariant<TWorkers>,
  key: keyof TWorkers,
) =>
  typeof variant.consumeQueues === "object" ? (variant.consumeQueues[key] ?? true) : (variant.consumeQueues ?? true);

/** A harness's config with a variant applied, for a harness without slots, which can't vary a run. */
const applyVariant = <TWorkers extends Record<string, CloudflareWorkerConfig>>(
  config: CloudflareHarnessConfig<TWorkers>,
  variant: CloudflareHarnessVariant<TWorkers>,
): CloudflareHarnessConfig<TWorkers> => ({
  ...config,
  workers: Object.fromEntries(
    Object.entries(config.workers).map(([key, worker]) => {
      // A Worker input is a config path or an inline config, either with vars of its own.
      const input = worker as CloudflareWorkerConfig & {
        config?: { queues?: { consumers?: unknown[] } };
        vars?: Record<string, unknown>;
      };
      const vars = variant.vars?.[key as keyof TWorkers];
      let applied: CloudflareWorkerConfig = vars
        ? ({ ...input, vars: { ...input.vars, ...vars } } as CloudflareWorkerConfig)
        : worker;
      const consume = consumesQueues(variant, key as keyof TWorkers);
      if (!consume && input.config?.queues?.consumers?.length) {
        applied = {
          ...applied,
          config: { ...input.config, queues: { ...input.config.queues, consumers: [] } },
        } as CloudflareWorkerConfig;
      } else if (!consume && !input.config) {
        throw new TypeError(
          `Worker ${key}: a variant that doesn't consume queues needs isolated Worker slots or an inline config`,
        );
      }
      return [key, applied];
    }),
  ) as TWorkers,
});
