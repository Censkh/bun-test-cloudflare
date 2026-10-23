import { expect, test } from "bun:test";
import { harness } from "./harness";

test("a Worker response body survives a garbage collection before it is read", async () => {
  await harness.run(async (workers) => {
    const responses = await Promise.all([
      workers.WORKER.fetch("https://worker.local/"),
      workers.WORKER.fetch("https://worker.local/"),
    ]);
    // Miniflare drops undici's own Response; without the harness patch a collection here cancels
    // the bodies the test still holds.
    Bun.gc(true);
    await Bun.sleep(50);
    expect(await Promise.all(responses.map((response) => response.text()))).toEqual(["kept body", "kept body"]);
  });
});
