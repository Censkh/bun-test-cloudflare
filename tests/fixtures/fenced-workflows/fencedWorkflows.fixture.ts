import { expect, test } from "bun:test";
import { harness } from "./harness";

const finished = async (instance: { status(): Promise<InstanceStatus> }) => {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await instance.status();
    if (["complete", "errored", "terminated"].includes(status.status) || Date.now() > deadline) return status;
    await Bun.sleep(100);
  }
};

// Each run's Workflow instances are its own: they run with the run's bindings, keep the IDs the run
// gave them, and another run can use the same ID.
test("a Workflow runs in its slot with its run's bindings, apart from other runs' instances", async () => {
  for (const value of ["first", "second"])
    await harness.run(async (workers) => {
      const env = await workers.WORKER.getEnv();
      expect(await env.KV.get("recorded:same")).toBeNull();
      const created = await workers.WORKER.fetch("https://example.com/", {
        method: "POST",
        body: JSON.stringify({ id: "same", value }),
      });
      expect(await created.json()).toEqual({ id: "same" });
      const status = await finished(await env.RECORD.get("same"));
      expect(status).toMatchObject({ status: "complete", output: { instanceId: "same", value } });
      expect(await env.KV.get("recorded:same")).toBe(value);
    });
});

test("a Workflow created from Bun runs in its run's slot too", async () => {
  await harness.run(async (workers) => {
    const env = await workers.WORKER.getEnv();
    const instance = await env.RECORD.create({ id: "from-bun", params: { value: "bun" } });
    expect(instance.id).toBe("from-bun");
    expect(await finished(instance)).toMatchObject({ status: "complete", output: { value: "bun" } });
    expect(await env.KV.get("recorded:from-bun")).toBe("bun");
  });
});
