import { expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { installChildProcessExtraFdPatch } from "../src/patches/ChildProcessExtraFdPatch";

const runExtraFdChild = async (index: number) => {
  const child = spawn(
    process.execPath,
    ["--eval", `const fs = require("node:fs"); fs.writeSync(3, "control-${index}\\n");`],
    {
      stdio: ["ignore", "ignore", "pipe", "pipe"],
    },
  );
  const controlPipe = child.stdio[3] as NodeJS.ReadableStream | null;
  if (!controlPipe) {
    throw new Error("Expected child stdio fd 3 to be readable");
  }

  let controlOutput = "";
  let stderrOutput = "";
  child.stderr?.setEncoding("utf8");
  controlPipe.on("data", (chunk) => {
    controlOutput += chunk.toString();
  });
  child.stderr?.on("data", (chunk) => {
    stderrOutput += chunk;
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    let childExitCode: number | null | undefined;
    let controlPipeEnded = false;
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `Timed out waiting for child ${index}: control=${JSON.stringify(controlOutput)} stderr=${JSON.stringify(
            stderrOutput,
          )}`,
        ),
      );
    }, 10_000);
    const finish = () => {
      if (childExitCode !== undefined && controlPipeEnded) {
        clearTimeout(timeout);
        resolve(childExitCode);
      }
    };

    child.once("exit", (code) => {
      childExitCode = code;
      finish();
    });
    child.once("error", reject);
    controlPipe.once("end", () => {
      controlPipeEnded = true;
      finish();
    });
    controlPipe.once("error", reject);
  });

  expect(exitCode).toBe(0);
  expect(stderrOutput).toBe("");
  expect(controlOutput).toContain(`control-${index}`);
};

test("ChildProcessExtraFdPatch supports parallel child stdio fd 3 reads", async () => {
  installChildProcessExtraFdPatch();

  await Promise.all(Array.from({ length: 32 }, (_, index) => runExtraFdChild(index)));
}, 15_000);
