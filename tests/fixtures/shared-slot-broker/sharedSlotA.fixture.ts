import { expect, test } from "bun:test";
import { harness } from "./harness";

// Each run, in whichever parallel test process, starts on clean storage and keeps its slot to
// itself while it runs: the others' writes, made at the same time, never show.
test("file A's runs each start clean and see only their own writes", async () => {
  for (let run = 0; run < 3; run++)
    await harness.run(async (workers, server) => {
      const env = await workers.WORKER.getEnv();
      expect(await env.KV.get("owner")).toBeNull();
      expect(await env.DB.prepare("SELECT name FROM sqlite_master WHERE name = 'entries'").first()).toBeNull();
      expect((await server.fetch("https://example.com/")).status).toBe(200);
      await env.KV.put("owner", "A");
      await env.DB.prepare("CREATE TABLE entries (id TEXT)").run();
      await Bun.sleep(150);
      expect(await env.KV.get("owner")).toBe("A");
    });
});
