import path from "node:path";
import { createTestHarness } from "wrangler";

const workerOptions = {
  workers: [
    {
      configPath: path.join(import.meta.dir, "wrangler.backend.toml"),
    },
    {
      configPath: path.join(import.meta.dir, "wrangler.other.toml"),
    },
  ],
};

export const runRawHarness = async (id: string) => {
  const server = createTestHarness(workerOptions);
  try {
    await server.listen();
    const worker = server.getWorker("workerd-control-pipe-race-backend");
    const response = await worker.fetch(`https://backend.local/?id=${id}`);
    if (response.status !== 200) {
      throw new Error(`unexpected status ${response.status}: ${await response.text()}`);
    }
    await response.arrayBuffer();
  } finally {
    await server.close();
  }
};
