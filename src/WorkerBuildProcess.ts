import { readFileSync, writeFileSync } from "node:fs";
import type { WorkerBuildPlan } from "./harness";

const [inputPath, outputPath, workerIndex] = process.argv.slice(2);
const plans = JSON.parse(readFileSync(inputPath!, "utf8")) as WorkerBuildPlan[];

if (workerIndex !== undefined) {
  const { buildWorkerOnce } = await import("./harness");
  try {
    const result = buildWorkerOnce(plans[Number(workerIndex)]!);
    writeFileSync(outputPath!, JSON.stringify({ result }));
  } catch (error) {
    writeFileSync(
      outputPath!,
      JSON.stringify({
        errorMessage: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { errorStack: error.stack } : {}),
      }),
    );
  }
} else {
  const children = plans.map((_, index) =>
    Bun.spawn({
      cmd: [process.execPath, import.meta.path, inputPath!, `${outputPath}.${index}`, String(index)],
      detached: process.platform !== "win32",
      stdout: "ignore",
      stderr: "pipe",
    }),
  );
  const stop = () => {
    for (const child of children) {
      try {
        if (process.platform === "win32") child.kill();
        else process.kill(-child.pid, "SIGTERM");
      } catch {
        // A child may have finished already.
      }
    }
    process.exit(1);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const results = await Promise.all(
    children.map(async (child, index) => {
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      if (exitCode !== 0) return { errorMessage: `Worker build process failed (${exitCode}): ${stderr}` };
      try {
        return JSON.parse(readFileSync(`${outputPath}.${index}`, "utf8"));
      } catch (error) {
        return { errorMessage: `Unable to read Worker build result: ${String(error)}` };
      }
    }),
  );
  writeFileSync(outputPath!, JSON.stringify(results));
}
