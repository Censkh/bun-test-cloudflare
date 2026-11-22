import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { harness } from "./harness";

const brokers = () => {
  const dir = path.join(os.tmpdir(), "bun-test-cloudflare-brokers");
  return (
    readdirSync(dir)
      .filter((file) => /^[0-9a-f]+\.json$/.test(file))
      .map((file) => JSON.parse(readFileSync(path.join(dir, file), "utf8")) as { parentPid: number; pid: number })
      .filter((broker) => broker.parentPid === process.ppid)
      // A killed broker's endpoint stays until the next one starts, and its pid can be reused.
      .filter((broker) =>
        Bun.spawnSync(["ps", "-o", "command=", "-p", String(broker.pid)])
          .stdout.toString()
          .includes("SharedSlotBrokerDaemon"),
      )
  );
};

// The broker serving this run's test processes is killed between two runs: the next lease starts
// another, as a test process's own runtime would be started again.
test("a broker that stops is replaced for the next run", async () => {
  await harness.run(async (workers) => {
    expect((await workers.WORKER.fetch("https://example.com/")).status).toBe(200);
  });
  const [first] = brokers();
  expect(first).toBeDefined();
  process.kill(first!.pid, "SIGKILL");
  await Bun.sleep(200);
  await harness.run(async (workers) => {
    expect((await workers.WORKER.fetch("https://example.com/")).status).toBe(200);
  });
  expect(brokers().map((broker) => broker.pid)).not.toContain(first!.pid);
});
