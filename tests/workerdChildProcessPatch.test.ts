import { expect, test } from "bun:test";
import { unrefWorkerdChildProcess } from "../src/patches/WorkerdChildProcessPatch";

test("keeps workerd's control pipe referenced for graceful shutdown", () => {
  const unrefCalls: string[] = [];
  const child = {
    stdio: Array.from({ length: 4 }, (_, index) => ({
      unref: () => unrefCalls.push(`stdio-${index}`),
    })),
    unref: () => unrefCalls.push("child"),
  } as unknown as Parameters<typeof unrefWorkerdChildProcess>[0];

  unrefWorkerdChildProcess(child, { stdioUnref: true, unref: true });

  expect(unrefCalls).toEqual(["child", "stdio-0", "stdio-1", "stdio-2"]);
});

test("can disable workerd process and stdio unref independently", () => {
  const unrefCalls: string[] = [];
  const child = {
    stdio: Array.from({ length: 4 }, (_, index) => ({
      unref: () => unrefCalls.push(`stdio-${index}`),
    })),
    unref: () => unrefCalls.push("child"),
  } as unknown as Parameters<typeof unrefWorkerdChildProcess>[0];

  unrefWorkerdChildProcess(child, { stdioUnref: true, unref: false });

  expect(unrefCalls).toEqual(["stdio-0", "stdio-1", "stdio-2"]);
});
