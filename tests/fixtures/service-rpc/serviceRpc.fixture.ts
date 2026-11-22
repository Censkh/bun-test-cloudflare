import { expect, test } from "bun:test";
import path from "node:path";
import { semver } from "bun";
import { createCloudflareHarness } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  isolatedWorkerSlots: 2,
  workers: {
    CALLER: { configPath: path.join(import.meta.dir, "caller.toml"), name: "service-rpc-caller" },
    TARGET: { configPath: path.join(import.meta.dir, "target.toml"), name: "service-rpc-target" },
  },
});

test("a Worker calls another's RPC methods through its service binding, callbacks and all, in its slot", async () => {
  for (let run = 0; run < 3; run++)
    await harness.run(async (workers) => {
      for (const pathname of ["/", "/object"]) {
        const response = await workers.CALLER.fetch(`https://example.com${pathname}`);
        expect(await response.json()).toEqual({ described: "target: part1part2" });
      }
    });
});

test("Bun calls the run's default Worker export on Wrangler versions that expose it", async () => {
  const supported = semver.satisfies(require("wrangler/package.json").version, ">=4.106.0");
  type Target = { label(value: string): Promise<string> };
  let previous: Target | undefined;
  for (const label of ["first", "second"]) {
    await harness.with({ vars: { TARGET: { LABEL: label } } }).run(async ({ TARGET }) => {
      expect("getExport" in TARGET).toBe(supported);
      if (supported) {
        const target = await (TARGET as unknown as { getExport(): Promise<Target> }).getExport();
        expect(await target.label("call")).toBe(`${label}: call`);
        if (previous) await expect(previous.label("late")).rejects.toMatchObject({ name: "CloudflareHarnessRunEnded" });
        previous = target;
      }
    });
  }
});

test("an ordinary Worker's export expires with its run", async () => {
  const ordinary = createCloudflareHarness({
    isolatedWorkerSlots: 1,
    workers: { TARGET: { configPath: path.join(import.meta.dir, "target.toml"), name: "service-rpc-target" } },
  });
  type Target = { label(value: string): Promise<string> };
  let entry: Target | undefined;
  await ordinary.run(async ({ TARGET }) => {
    const handle = TARGET as unknown as { getExport?: () => Promise<Target> };
    if (semver.satisfies(require("wrangler/package.json").version, ">=4.106.0")) {
      entry = await handle.getExport!();
      expect(await entry.label("call")).toBe("target: call");
    } else {
      expect(handle.getExport).toBeUndefined();
    }
  });
  if (entry) await expect(entry.label("late")).rejects.toMatchObject({ name: "CloudflareHarnessRunEnded" });
});
