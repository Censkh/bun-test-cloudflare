import { expect, test } from "bun:test";
import { createCloudflareHarness, typeToken } from "bun-test-cloudflare";

const harness = createCloudflareHarness({
  isolatedWorkerSlots: 1,
  workers: {
    HOST: {
      name: "workerd-run",
      configPath: `${import.meta.dir}/wrangler.toml`,
      bindings: typeToken<{ DB: D1Database; OBSERVED: KVNamespace }>(),
    },
  },
});

test("reuses two binding slots with fresh modules and rejects retired background writes", async () => {
  await harness.run(async ({ HOST }) => {
    const { DB, OBSERVED } = await HOST.getEnv();
    await DB.exec("CREATE TABLE effects (slot TEXT, run TEXT, source TEXT, PRIMARY KEY (slot, source))");
    const request = (path: string, delay: boolean | null = null) =>
      HOST.fetch(`https://example.test/${path}`, { method: "POST", body: JSON.stringify({ delay }) });
    const activate = async (slot: string, run: string) => {
      expect((await request(`activate/${slot}/${run}`)).status).toBe(204);
    };
    await activate("a", "old");
    expect((await request("hold/a/old")).status).toBe(204);
    expect(await (await request("work/a/old", true)).json()).toBe(1);
    expect(await (await request("work/a/old")).json()).toBe(2);

    await activate("b", "other-slot");
    expect(await (await request("work/b/other-slot", false)).json()).toBe(1);

    const waitFor = async (ready: () => Promise<boolean>) => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await ready()) return;
        await Bun.sleep(20);
      }
      throw new Error("Timed out waiting for Workerd");
    };
    const admitted = request("hold-write/a/old");
    await waitFor(async () => (await OBSERVED.get("admitted")) === "true");
    const rotation = request("activate/a/next");
    await waitFor(async () => (await request("work/a/old")).status === 410);
    await OBSERVED.put("release", "true");
    expect((await admitted).status).toBe(204);
    expect((await rotation).status).toBe(204);
    await OBSERVED.put("rotated", "true");
    expect(await (await request("work/a/next", false)).json()).toBe(1);
    expect((await request("work/a/old")).status).toBe(410);

    const sources = ["alarm", "queue", "waitUntil"];
    const rows = () => DB.prepare("SELECT * FROM effects ORDER BY slot, source").all();
    const outcomes = () => Promise.all(sources.map((source) => OBSERVED.get(`old/${source}`)));
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await outcomes()).every((outcome) => outcome === "rejected") && (await rows()).results.length === 6) break;
      await Bun.sleep(50);
    }
    expect(await outcomes()).toEqual(sources.map(() => "rejected"));
    expect((await rows()).results).toEqual([
      ...sources.map((source) => ({ slot: "a", run: "next", source })),
      ...sources.map((source) => ({ slot: "b", run: "other-slot", source })),
    ]);
  });
});

test("fenced D1 executes prepared statements and rolls back a failing batch like native D1", async () => {
  await harness.run(async ({ HOST }) => {
    const { DB } = await HOST.getEnv();
    await DB.exec("CREATE TABLE effects (slot TEXT, run TEXT, source TEXT)");
    expect((await HOST.fetch("https://example.test/activate/a/d1")).status).toBe(204);
    const [reference, proxied] = await Promise.all([
      HOST.fetch("https://example.test/native-d1"),
      HOST.fetch("https://example.test/d1/a/d1"),
    ]);
    expect(reference.status).toBe(200);
    if (!proxied.ok) throw new Error(await proxied.text());
    const expected = await reference.json();
    expect(expected).toMatchObject({
      changes: 1,
      rolledBack: true,
      column: "63",
      missing: null,
      raw: [
        ["id", "bytes"],
        [1, "00FF"],
        [2, "63"],
      ],
    });
    expect(await proxied.json()).toEqual(expected);
  });
});
