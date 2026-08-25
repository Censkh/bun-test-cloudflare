import { expect, test } from "bun:test";
import { patchWorkerdChildProcess } from "../src/patches/WorkerdChildProcessPatch";

test("keeps workerd's control pipe referenced for graceful shutdown", () => {
  const unrefCalls: string[] = [];
  const handledErrors: string[] = [];
  const child = {
    stdio: Array.from({ length: 4 }, (_, index) => ({
      on: (event: string) => handledErrors.push(`${event}-${index}`),
      unref: () => unrefCalls.push(`stdio-${index}`),
    })),
    unref: () => unrefCalls.push("child"),
  } as unknown as Parameters<typeof patchWorkerdChildProcess>[0];

  patchWorkerdChildProcess(child, { stdioErrors: true, stdioUnref: true, unref: true });

  expect(handledErrors).toEqual(["error-0", "error-1", "error-2", "error-3"]);
  expect(unrefCalls).toEqual(["child", "stdio-0", "stdio-1", "stdio-2"]);
});

test("can disable workerd process and stdio unref independently", () => {
  const unrefCalls: string[] = [];
  const child = {
    stdio: Array.from({ length: 4 }, (_, index) => ({
      unref: () => unrefCalls.push(`stdio-${index}`),
    })),
    unref: () => unrefCalls.push("child"),
  } as unknown as Parameters<typeof patchWorkerdChildProcess>[0];

  patchWorkerdChildProcess(child, { stdioErrors: false, stdioUnref: true, unref: false });

  expect(unrefCalls).toEqual(["stdio-0", "stdio-1", "stdio-2"]);
});
