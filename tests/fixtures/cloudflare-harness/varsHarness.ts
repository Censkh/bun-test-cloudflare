import path from "node:path";
import { createCloudflareHarness } from "bun-test-cloudflare";

// A harness whose Worker reads a var each file fills in only after creating it, as a test sets a
// URL once the service it points at has started.
export const vars = { GREETING: "" };

export const varsHarness = createCloudflareHarness({
  workers: {
    VARS: {
      config: {
        name: "vars-fixture",
        main: path.join(import.meta.dir, "src/vars.ts"),
        compatibility_date: "2025-08-15",
        vars,
      },
    },
  },
});
