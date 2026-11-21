import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { semver } from "bun";
import {
  canUseFencedWorkerSlots,
  cleanupFencedWorkerSlots,
  createFencedWorkerSlots,
  isSupportedSlotBinding,
  wranglerKeepsSecondaryRateLimits,
} from "../src/FencedWorkerSlots";

const installedWranglerKeepsSecondaryRateLimits = semver.satisfies(
  (require("wrangler/package.json") as { version: string }).version,
  ">=4.108.0",
);

const workerInput = (config: Record<string, unknown>) => ({ input: { config } as any, name: "worker" });

test("fenced Worker slots accept resettable storage and immutable value bindings", () => {
  expect(
    canUseFencedWorkerSlots([
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

test("fenced Worker slots accept queues, static assets and bindings every slot can share", () => {
  const workerNames = new Set(["worker"]);
  for (const binding of [
    { dataset: "events", type: "analytics_engine" },
    { directory: "./assets", type: "assets" },
    { type: "browser" },
    { id: "hyperdrive", localConnectionString: "postgres://localhost/db", type: "hyperdrive" },
    { queue: "jobs", queue_name: "jobs", type: "queue" },
    { type: "send_email" },
    { type: "version_metadata" },
  ]) {
    expect({ binding, supported: isSupportedSlotBinding(binding, workerNames) }).toEqual({ binding, supported: true });
  }
  expect(isSupportedSlotBinding({ type: "queue" }, workerNames)).toBeFalse();
});

const rateLimit = { namespace_id: "1001", simple: { limit: 5, period: 60 }, type: "ratelimit" };

test.skipIf(!installedWranglerKeepsSecondaryRateLimits)(
  "fenced Worker slots accept rate limits with a namespace on Wrangler 4.108 and later",
  () => {
    const workerNames = new Set(["worker"]);
    expect(isSupportedSlotBinding(rateLimit, workerNames)).toBeTrue();
    expect(isSupportedSlotBinding({ type: "ratelimit" }, workerNames)).toBeFalse();
  },
);

test.skipIf(installedWranglerKeepsSecondaryRateLimits)(
  "fenced Worker slots reject rate limits before Wrangler 4.108, which drops them from every slot but the first",
  () => {
    expect(isSupportedSlotBinding(rateLimit, new Set(["worker"]))).toBeFalse();
  },
);

test("only Wrangler 4.108 and later keep the rate limits of Workers other than the primary one", () => {
  expect(wranglerKeepsSecondaryRateLimits("4.104.0")).toBeFalse();
  expect(wranglerKeepsSecondaryRateLimits("4.107.0")).toBeFalse();
  expect(wranglerKeepsSecondaryRateLimits("4.108.0")).toBeTrue();
  expect(wranglerKeepsSecondaryRateLimits("4.152.0")).toBeTrue();
});

test("fenced Worker slots reject unsupported, workflow, container, and unidentified storage bindings", () => {
  expect(
    canUseFencedWorkerSlots([workerInput({ services: [{ binding: "EXTERNAL", service: "external-worker" }] })]),
  ).toBeFalse();
  expect(canUseFencedWorkerSlots([workerInput({ kv_namespaces: [{ binding: "KV" }] })])).toBeFalse();
  expect(canUseFencedWorkerSlots([workerInput({ containers: [{ class_name: "ContainerWorker" }] })])).toBeFalse();
  expect(
    canUseFencedWorkerSlots([workerInput({ workflows: [{ binding: "FLOW", class_name: "Flow", name: "flow" }] })]),
  ).toBeFalse();
});

test("fenced Worker slots support cyclic Worker bindings", () => {
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

  expect(canUseFencedWorkerSlots(workers)).toBeTrue();
});

test("fenced Worker slots create per-slot supervisors and native Durable Object hosts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-services-"));
  const main = path.join(root, "worker.js");
  fs.writeFileSync(main, "export class Counter {}\nexport default { fetch() { return new Response('ok'); } };\n");

  let cleanupDir: string | undefined;
  try {
    const slots = createFencedWorkerSlots(
      [
        {
          input: {
            config: {
              durable_objects: {
                bindings: [{ class_name: "Counter", name: "COUNTER", script_name: "service-worker" }],
              },
              main,
              name: "entry-worker",
              services: [{ binding: "SERVICE", service: "service-worker" }],
            },
          } as any,
          name: "entry-worker",
        },
        {
          input: {
            config: {
              main,
              migrations: [{ tag: "v1", new_sqlite_classes: ["Counter"] }],
              name: "service-worker",
            },
          } as any,
          name: "service-worker",
        },
      ],
      2,
    );
    cleanupDir = slots.cleanupDir;

    expect(slots.slotSupervisorNames).toEqual(["__btcf-supervisor--slot-0", "__btcf-supervisor--slot-1"]);
    const slot0Supervisor = (slots.inputs[0] as any).config;
    const slot0DoHost = (slots.inputs[1] as any).config;
    const slot1Supervisor = (slots.inputs[2] as any).config;
    const slot1DoHost = (slots.inputs[3] as any).config;

    expect(slot0Supervisor.name).toBe("__btcf-supervisor--slot-0");
    expect(slot1Supervisor.name).toBe("__btcf-supervisor--slot-1");
    expect(slot0DoHost.name).toBe("service-worker--btcf-do-0");
    expect(slot1DoHost.name).toBe("service-worker--btcf-do-1");
    expect(slot0Supervisor.durable_objects.bindings).toContainEqual({
      name: "DO_0",
      class_name: "Counter",
      script_name: "service-worker--btcf-do-0",
    });
    expect(slot1Supervisor.durable_objects.bindings).toContainEqual({
      name: "DO_0",
      class_name: "Counter",
      script_name: "service-worker--btcf-do-1",
    });
    expect(slots.workerSpecs[0]?.bindings.SERVICE).toEqual({ kind: "service", target: "service-worker" });
    expect(slots.workerSpecs[0]?.bindings.COUNTER).toEqual({ kind: "do", sup: "DO_0" });
  } finally {
    cleanupFencedWorkerSlots(cleanupDir);
    fs.rmSync(root, { force: true, recursive: true });
  }
});

test("fenced Worker slots isolate per-slot storage, queue, and rate limit identities on supervisors", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bun-test-cloudflare-slots-"));
  const main = path.join(root, "worker.js");
  fs.writeFileSync(main, "export default { fetch() { return new Response('ok'); } };\n");

  let cleanupDir: string | undefined;
  try {
    const slots = createFencedWorkerSlots(
      [
        workerInput({
          d1_databases: [{ binding: "DB", database_id: "database", database_name: "database" }],
          find_additional_modules: true,
          kv_namespaces: [{ binding: "KV", id: "namespace" }],
          main,
          name: "worker",
          queues: {
            consumers: [{ dead_letter_queue: "jobs-failed", queue: "jobs" }],
            producers: [{ binding: "JOBS", queue: "jobs" }],
          },
          r2_buckets: [{ binding: "BUCKET", bucket_name: "bucket" }],
          ratelimits: [{ name: "LIMITER", namespace_id: "1001", simple: { limit: 5, period: 60 } }],
        }),
      ],
      2,
    );
    cleanupDir = slots.cleanupDir;
    const firstConfig = (slots.inputs[0] as any).config;
    const secondConfig = (slots.inputs[1] as any).config;

    expect(slots.slotSupervisorNames).toEqual(["__btcf-supervisor--slot-0", "__btcf-supervisor--slot-1"]);
    expect(firstConfig.kv_namespaces[0].id).toBe("namespace--btcf-slot-0");
    expect(secondConfig.kv_namespaces[0].id).toBe("namespace--btcf-slot-1");
    expect(firstConfig.d1_databases[0].database_id).toBe("database--btcf-slot-0");
    expect(secondConfig.r2_buckets[0].bucket_name).toBe("bucket--btcf-slot-1");
    expect(secondConfig.queues.producers[0].queue).toBe("jobs--btcf-slot-1");
    expect(secondConfig.queues.consumers[0]).toEqual({
      dead_letter_queue: "jobs-failed--btcf-slot-1",
      queue: "jobs--btcf-slot-1",
    });
    expect(firstConfig.ratelimits[0].namespace_id).not.toBe(secondConfig.ratelimits[0].namespace_id);
  } finally {
    cleanupFencedWorkerSlots(cleanupDir);
    fs.rmSync(root, { force: true, recursive: true });
  }
});
