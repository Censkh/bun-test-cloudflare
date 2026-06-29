import crypto from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestHarness, TestHarnessOptions, WorkerHandle } from "wrangler";
import { unstable_readConfig } from "wrangler";
import {
  type CloudflareHarnessRunContext,
  getCloudflareHarnessRunContext,
  HarnessRun,
  type PreparedWorkerInput,
} from "./HarnessRun";
import { installWranglerPatches } from "./wranglerPatches";

type WorkerInput = TestHarnessOptions["workers"][number];

export type TypeToken<T> = {
  readonly __type?: T;
};

export const typeToken = <T>(): TypeToken<T> => ({});

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
  events?: {
    beforeRun?: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<void> | void;
  };
  workers: TWorkers;
};

export type CloudflareHarness<TWorkers extends Record<string, CloudflareWorkerConfig>> = {
  run<TResult>(
    callback: (workers: CloudflareWorkerMap<TWorkers>, server: TestHarness) => Promise<TResult> | TResult,
  ): Promise<TResult>;
};

export { type CloudflareHarnessRunContext, getCloudflareHarnessRunContext };

installWranglerPatches();

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

const withDryRunModuleRules = (rules: Array<Record<string, any>> | undefined) => [
  ...(rules ?? []),
  { type: "CompiledWasm", globs: ["**/*.wasm", "**/*.wasm?module"] },
];

const sanitizeWorkerName = (workerName: string) => workerName.replace(/[^a-zA-Z0-9._-]/g, "-");

const getWorkerBuildOutdir = (baseDirectory: string, workerName: string) =>
  path.join(baseDirectory, "node_modules/.btcf/worker-build", sanitizeWorkerName(workerName));

const getWranglerBinPath = () => {
  const wranglerPackageJsonPath = fileURLToPath(import.meta.resolve("wrangler/package.json"));
  const wranglerPackageJson = JSON.parse(readFileSync(wranglerPackageJsonPath, "utf8")) as {
    bin?: { wrangler?: string };
  };
  return path.join(path.dirname(wranglerPackageJsonPath), wranglerPackageJson.bin?.wrangler ?? "bin/wrangler.js");
};

const sleepSync = (durationMs: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
};

const isErrnoException = (error: unknown): error is NodeJS.ErrnoException => error instanceof Error && "code" in error;
const buildWaitTimeoutMs = 15_000;

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

type WorkerBuildPlan = {
  buildKey: string;
  config: Record<string, any>;
  env: string | undefined;
  outdir: string;
  statusPath: string;
  testConfig: Record<string, any>;
  workerName: string;
};

const getBunTestWorkerId = () => process.env.BUN_TEST_WORKER_ID ?? process.env.JEST_WORKER_ID;

const isWorkerBuildOwner = () => {
  const workerId = getBunTestWorkerId();
  return workerId === undefined || workerId === "1";
};

const getBunTestRunKey = () => (getBunTestWorkerId() === undefined ? String(process.pid) : String(process.ppid));

const getBuildStatusPath = (outdir: string) => `${outdir}.build-${getBunTestRunKey()}.json`;

const createBuildKey = (config: Record<string, any>, env: string | undefined) =>
  crypto.createHash("sha256").update(JSON.stringify({ config, env })).digest("hex");

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

const waitForWorkerBuild = (statusPath: string, buildKey: string, outdir: string): WorkerBuildResult => {
  const start = Date.now();
  while (Date.now() - start <= buildWaitTimeoutMs) {
    const status = readBuildStatus(statusPath);
    if (status?.buildKey === buildKey) {
      if (status.state === "success" && existsSync(status.builtMain)) {
        return { built: false, builtMain: status.builtMain };
      }
      if (status.state === "failure") {
        throwBuildFailure(status);
      }
    }
    sleepSync(50);
  }

  throw new Error(`Timed out waiting for worker build: ${outdir}`);
};

const withBuildLock = <TResult>(outdir: string, callback: () => TResult) => {
  const lockPath = `${outdir}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  let lockFile: number | undefined;
  while (lockFile === undefined) {
    try {
      lockFile = openSync(lockPath, "wx");
      writeFileSync(lockFile, `${process.pid}\n`);
      closeSync(lockFile);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() - start > buildWaitTimeoutMs) {
        throw new Error(`Timed out waiting for worker build lock: ${lockPath}`);
      }
      sleepSync(50);
    }
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

const runWranglerDryRun = (configPath: string, outdir: string, env: string | undefined) => {
  mkdirSync(outdir, { recursive: true });
  const wranglerBinPath = getWranglerBinPath();
  const args = [wranglerBinPath, "deploy", "--dry-run", "--outdir", outdir, "--config", configPath];
  if (env) {
    args.push("--env", env);
  }

  const result = Bun.spawnSync({
    cmd: [process.execPath, ...args],
    stderr: "pipe",
    stdout: "pipe",
  });
  const stdout = result.stdout.toString();
  const stderr = result.stderr.toString();

  if (result.exitCode !== 0) {
    throw new Error(
      [
        `wrangler deploy --dry-run failed for ${configPath}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : undefined,
        stderr.trim() ? `stderr:\n${stderr.trim()}` : undefined,
      ]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
};

const createWorkerBuildPlan = (
  workerName: string,
  outdir: string,
  testConfig: Record<string, any>,
  config: Record<string, any>,
  env: string | undefined,
): WorkerBuildPlan => ({
  buildKey: createBuildKey(testConfig, env),
  config,
  env,
  outdir,
  statusPath: getBuildStatusPath(outdir),
  testConfig,
  workerName,
});

const shouldBuildWorker = (plan: WorkerBuildPlan) => {
  if (!isWorkerBuildOwner()) {
    return false;
  }

  return withBuildLock(plan.outdir, () => {
    const existingStatus = readBuildStatus(plan.statusPath);
    if (existingStatus?.buildKey !== plan.buildKey) {
      return true;
    }
    if (existingStatus.state === "success" && existsSync(existingStatus.builtMain)) {
      return false;
    }
    if (existingStatus.state === "failure") {
      throwBuildFailure(existingStatus);
    }
    return true;
  });
};

const buildWorkerOnce = (plan: WorkerBuildPlan): WorkerBuildResult => {
  if (!isWorkerBuildOwner()) {
    return waitForWorkerBuild(plan.statusPath, plan.buildKey, plan.outdir);
  }

  return withBuildLock(plan.outdir, () => {
    const existingStatus = readBuildStatus(plan.statusPath);
    if (existingStatus?.buildKey === plan.buildKey) {
      if (existingStatus.state === "success" && existsSync(existingStatus.builtMain)) {
        return { built: false, builtMain: existingStatus.builtMain };
      }
      if (existingStatus.state === "failure") {
        throwBuildFailure(existingStatus);
      }
    }

    writeBuildStatus(plan.statusPath, { buildKey: plan.buildKey, ownerPid: process.pid, state: "building" });
    try {
      const testConfigPath = writeResolvedConfig(plan.outdir, plan.testConfig);
      runWranglerDryRun(testConfigPath, plan.outdir, plan.env);
      const builtMain = normalizeBuiltMain(plan.outdir, findBuiltMain(plan.outdir, plan.config.main));
      writeBuildStatus(plan.statusPath, { buildKey: plan.buildKey, builtMain, state: "success" });
      return { built: true, builtMain };
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

const resolveInlineConfig = (
  input: Extract<WorkerInput, { config: unknown }>,
  root: string | undefined,
  workerName: string,
) => {
  const config = input.config as Record<string, any>;
  const resolvedMain =
    typeof config.main === "string" && !path.isAbsolute(config.main)
      ? path.resolve(root ?? process.cwd(), config.main)
      : config.main;
  const resolvedConfig = {
    ...config,
    ...(resolvedMain ? { main: resolvedMain } : {}),
  };
  const outdir = getWorkerBuildOutdir(path.resolve(root ?? process.cwd()), workerName);
  const configPath = writeResolvedConfig(outdir, resolvedConfig);

  return { config: resolvedConfig, configPath, outdir };
};

const resolveWorkerConfig = (input: WorkerInput, root: string | undefined, fallbackWorkerName: string) => {
  if ("configPath" in input) {
    const { configPath, env } = input;
    const resolvedConfigPath = resolveConfigPath(configPath, root);
    const config = unstable_readConfig({ config: resolvedConfigPath, ...(env ? { env } : {}) }, { hideWarnings: true });
    return {
      config,
      configPath: resolvedConfigPath,
      outdir: getWorkerBuildOutdir(path.dirname(resolvedConfigPath), config.name ?? fallbackWorkerName),
    };
  }

  return resolveInlineConfig(input, root, (input.config as Record<string, any>).name ?? fallbackWorkerName);
};

const prepareWorkerInput = (
  key: string,
  worker: CloudflareWorkerConfig,
  root: string | undefined,
): PreparedWorkerInput => {
  const start = performance.now();
  const { bindings: _bindings, name: _name, ...input } = worker;

  const vars = "vars" in input ? input.vars : undefined;
  const secrets = "secrets" in input ? input.secrets : undefined;
  const env = "env" in input ? input.env : undefined;
  const { config, outdir } = resolveWorkerConfig(input, root, worker.name ?? key);
  const workerName = worker.name ?? config.name ?? key;
  const testConfig = withTestEnvironmentDefine(config);
  const buildPlan = createWorkerBuildPlan(workerName, outdir, testConfig, config, env);
  const buildResult = buildWorkerOnce(buildPlan);

  return {
    built: buildResult.built,
    durationMs: performance.now() - start,
    input: {
      config: {
        ...testConfig,
        base_dir: outdir,
        find_additional_modules: true,
        main: buildResult.builtMain,
        no_bundle: true,
        rules: withDryRunModuleRules(config.rules),
      },
      ...(vars ? { vars } : {}),
      ...(secrets ? { secrets } : {}),
    } as WorkerInput,
    name: workerName,
  };
};

export const createCloudflareHarness = <const TWorkers extends Record<string, CloudflareWorkerConfig>>(
  config: CloudflareHarnessConfig<TWorkers>,
): CloudflareHarness<TWorkers> => {
  const { events, workers: workerConfigs, ...serverConfig } = config;
  const workerEntries = Object.entries(workerConfigs) as Array<[keyof TWorkers, CloudflareWorkerConfig]>;
  const buildPlans = workerEntries.map(([key, worker]) => {
    const { bindings: _bindings, name: _name, ...input } = worker;
    const env = "env" in input ? input.env : undefined;
    const { config, outdir } = resolveWorkerConfig(input, serverConfig.root, worker.name ?? String(key));
    const workerName = worker.name ?? config.name ?? String(key);
    return createWorkerBuildPlan(workerName, outdir, withTestEnvironmentDefine(config), config, env);
  });
  const workersToBuild = buildPlans.filter(shouldBuildWorker);
  if (workersToBuild.length > 0) {
    console.info(`[bun-test-cloudflare] Building ${workersToBuild.length} worker(s)`);
  }
  const preparedWorkers = workerEntries.map(([key, worker]) =>
    prepareWorkerInput(String(key), worker, serverConfig.root),
  );
  const builtWorkers = preparedWorkers.filter((worker) => worker.built);
  if (builtWorkers.length > 0) {
    console.info(
      [
        "[bun-test-cloudflare] Built workers:",
        ...builtWorkers.map((worker) => `- ${worker.name} (${worker.durationMs.toFixed(1)}ms)`),
      ].join("\n"),
    );
  }

  const testHarnessOptions = {
    ...serverConfig,
    workers: preparedWorkers.map((worker) => worker.input),
  };

  return {
    run(callback) {
      return new HarnessRun({
        events,
        preparedWorkers,
        testHarnessOptions,
        workerEntries,
      }).execute(callback);
    },
  };
};
