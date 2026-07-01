import path from "node:path";
import { createTestHarness } from "wrangler";

const backendMain = path.join(import.meta.dir, "src/backend-built.js");
const otherMain = path.join(import.meta.dir, "src/other-built.js");

const workerOptions = {
  workers: [
    {
      config: {
        name: "workerd-control-pipe-no-bundle-backend",
        main: backendMain,
        compatibility_date: "2025-08-15",
        compatibility_flags: ["nodejs_compat"],
        no_bundle: true,
        services: [{ binding: "OTHER", service: "workerd-control-pipe-no-bundle-other" }],
        d1_databases: [
          {
            binding: "DB",
            database_name: "workerd-control-pipe-no-bundle-db",
            database_id: "workerd-control-pipe-no-bundle-db",
          },
        ],
        kv_namespaces: [{ binding: "KV", id: "workerd-control-pipe-no-bundle-kv" }],
        r2_buckets: [{ binding: "DOCUMENTS", bucket_name: "workerd-control-pipe-no-bundle-documents" }],
      },
    },
    {
      config: {
        name: "workerd-control-pipe-no-bundle-other",
        main: otherMain,
        compatibility_date: "2025-08-15",
        compatibility_flags: ["nodejs_compat"],
        no_bundle: true,
      },
    },
  ],
};

export const runRawNoBundleHarness = async (id: string) => {
  const server = createTestHarness(workerOptions);
  try {
    await server.listen();
    const worker = server.getWorker("workerd-control-pipe-no-bundle-backend");
    const response = await worker.fetch(`https://backend.local/?id=${id}`);
    if (response.status !== 200) {
      throw new Error(`unexpected status ${response.status}: ${await response.text()}`);
    }
    await response.arrayBuffer();
  } finally {
    await server.close();
  }
};
