import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canUseIsolatedWorkerSlots, createIsolatedWorkerSlots } from "../src/WorkerSlots";

const workerInput = (config: Record<string, unknown>) => ({ input: { config } as any, name: "worker" });

test("isolated Worker slots accept resettable storage and immutable value bindings", () => {
  expect(
    canUseIsolatedWorkerSlots([
      workerInput({
        d1_databases: [{ binding: "DB", database_id: "database", database_name: "database" }],
        durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
        images: { binding: "IMAGES" },
        kv_namespaces: [{ binding: "KV", id: "namespace" }],
        r2_buckets: [{ binding: "BUCKET", bucket_name: "bucket" }],
        vars: { JSON: { enabled: true }, TEXT: "value" },
      }),
    ]),
  ).toBeTrue();
});

test("isolated Worker slots reject unsupported and unidentified storage bindings", () => {
  expect(
    canUseIsolatedWorkerSlots([workerInput({ services: [{ binding: "EXTERNAL", service: "external-worker" }] })]),
  ).toBeFalse();
  expect(canUseIsolatedWorkerSlots([workerInput({ kv_namespaces: [{ binding: "KV" }] })])).toBeFalse();
  expect(canUseIsolatedWorkerSlots([workerInput({ containers: [{ class_name: "ContainerWorker" }] })])).toBeFalse();
});

test("isolated Worker slots support cyclic Worker bindings", () => {
  const workers = [
    {
      input: {
        config: {
          durable_objects: {
            bindings: [{ class_name: "SecondObject", name: "SECOND_OBJECT", script_name: "second-worker" }],
          },
          services: [{ binding: "SECOND", service: "second-worker" }],
        },
      } as any,
      name: "first-worker",
    },
    {
      input: {
        config: {
          durable_objects: {
            bindings: [{ class_name: "FirstObject", name: "FIRST_OBJECT", script_name: "first-worker" }],
          },
          services: [{ binding: "FIRST", service: "first-worker" }],
        },
      } as any,
      name: "second-worker",
    },
  ];

  expect(canUseIsolatedWorkerSlots(workers)).toBeTrue();
});

test("isolated Worker slots rewrite internal service and Durable Object targets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-services-"));
  const main = path.join(root, "worker.js");
  fs.writeFileSync(main, "export default { fetch() { return new Response('ok'); } };\n");

  try {
    const slots = createIsolatedWorkerSlots(
      [
        {
          input: {
            config: {
              durable_objects: {
                bindings: [{ class_name: "Counter", name: "COUNTER", script_name: "service-worker" }],
              },
              main,
              migrations: [
                {
                  tag: "v1",
                  transferred_classes: [{ from: "Counter", from_script: "service-worker", to: "TransferredCounter" }],
                },
              ],
              name: "entry-worker",
              services: [{ binding: "SERVICE", service: "service-worker" }],
            },
          } as any,
          name: "entry-worker",
        },
        {
          input: { config: { main, name: "service-worker" } } as any,
          name: "service-worker",
        },
      ],
      2,
    );
    const firstEntryConfig = (slots.inputs[0] as any).config;
    const secondEntryConfig = (slots.inputs[2] as any).config;

    expect(firstEntryConfig.services[0].service).toBe("service-worker--btcf-slot-0");
    expect(secondEntryConfig.services[0].service).toBe("service-worker--btcf-slot-1");
    expect(firstEntryConfig.durable_objects.bindings[0].script_name).toBe("service-worker--btcf-slot-0");
    expect(firstEntryConfig.migrations[0].transferred_classes[0].from_script).toBe("service-worker--btcf-slot-0");
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("isolated Worker slots clone storage identities and generate cache wrappers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-slots-"));
  const main = path.join(root, "worker.js");
  fs.writeFileSync(main, "export default { fetch() { return new Response('ok'); } };\n");

  try {
    const slots = createIsolatedWorkerSlots(
      [
        workerInput({
          d1_databases: [{ binding: "DB", database_id: "database", database_name: "database" }],
          find_additional_modules: true,
          kv_namespaces: [{ binding: "KV", id: "namespace" }],
          main,
          name: "worker",
          r2_buckets: [{ binding: "BUCKET", bucket_name: "bucket" }],
          rules: [{ globs: ["**/*.wasm"], type: "CompiledWasm" }],
        }),
      ],
      2,
    );
    const firstConfig = (slots.inputs[0] as any).config;
    const secondConfig = (slots.inputs[1] as any).config;

    expect(slots.workerNames).toEqual([["worker--btcf-slot-0", "worker--btcf-slot-1"]]);
    expect(firstConfig.kv_namespaces[0].id).toBe("namespace--btcf-slot-0");
    expect(secondConfig.kv_namespaces[0].id).toBe("namespace--btcf-slot-1");
    expect(firstConfig.d1_databases[0].database_id).toBe("database--btcf-slot-0");
    expect(secondConfig.r2_buckets[0].bucket_name).toBe("bucket--btcf-slot-1");
    expect(fs.readFileSync(firstConfig.main, "utf8")).toContain("cache-namespace.js");
    expect(firstConfig.rules[0]).toEqual({
      fallthrough: true,
      globs: ["worker.js", path.basename(firstConfig.main).replace(".cache-bridge.js", ".cache-namespace.js")],
      type: "ESModule",
    });
    expect(firstConfig.rules[1]).toEqual({ globs: ["**/*.wasm"], type: "CompiledWasm" });
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
});
