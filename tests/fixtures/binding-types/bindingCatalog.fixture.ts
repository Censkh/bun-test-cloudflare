import { expect, test } from "bun:test";
import { unstable_convertConfigBindingsToStartWorkerBindings } from "wrangler";
import { canUseIsolatedWorkerSlots, isSupportedSlotBinding } from "../../../src/WorkerSlots";

test("classifies every binding kind emitted by Wrangler for isolated slots", () => {
  const config = {
    agent_memory: [{ binding: "AGENT_MEMORY", namespace: "namespace" }],
    ai: { binding: "AI" },
    ai_search: [{ binding: "AI_SEARCH", instance_name: "instance" }],
    ai_search_namespaces: [{ binding: "AI_SEARCH_NAMESPACE", namespace: "namespace" }],
    analytics_engine_datasets: [{ binding: "ANALYTICS", dataset: "dataset" }],
    artifacts: [{ binding: "ARTIFACTS", namespace: "namespace" }],
    assets: { binding: "ASSETS", directory: "public" },
    browser: { binding: "BROWSER" },
    d1_databases: [{ binding: "DB", database_id: "database" }],
    data_blobs: { DATA: new Uint8Array([1]) },
    dispatch_namespaces: [{ binding: "DISPATCH", namespace: "namespace" }],
    durable_objects: { bindings: [{ class_name: "Counter", name: "COUNTER" }] },
    flagship: [{ binding: "FLAGSHIP" }],
    hyperdrive: [{ binding: "HYPERDRIVE", id: "hyperdrive" }],
    images: { binding: "IMAGES" },
    kv_namespaces: [{ binding: "KV", id: "namespace" }],
    logfwdr: { bindings: [{ destination: "destination", name: "LOGFWDR" }] },
    media: { binding: "MEDIA" },
    mtls_certificates: [{ binding: "MTLS", certificate_id: "certificate" }],
    pipelines: [{ binding: "PIPELINE", pipeline: "pipeline" }],
    queues: { producers: [{ binding: "QUEUE", queue: "queue" }] },
    r2_buckets: [{ binding: "R2", bucket_name: "bucket" }],
    ratelimits: [{ name: "RATE_LIMIT", namespace_id: "1", simple: { limit: 1, period: 60 } }],
    secrets_store_secrets: [{ binding: "SECRET", secret_name: "secret", store_id: "store" }],
    send_email: [{ name: "EMAIL" }],
    services: [{ binding: "SERVICE", service: "service" }],
    stream: { binding: "STREAM" },
    text_blobs: { TEXT: "text.txt" },
    unsafe: { bindings: [{ name: "UNSAFE", type: "custom" }] },
    unsafe_hello_world: [{ binding: "HELLO_WORLD" }],
    vars: { JSON: { ok: true }, TEXT_VALUE: "value" },
    vectorize: [{ binding: "VECTORIZE", index_name: "index" }],
    version_metadata: { binding: "VERSION" },
    vpc_networks: [{ binding: "VPC_NETWORK", network_id: "network" }],
    vpc_services: [{ binding: "VPC_SERVICE", service_id: "service" }],
    wasm_modules: { WASM: new Uint8Array([0]) },
    websearch: { binding: "WEBSEARCH" },
    worker_loaders: [{ binding: "LOADER" }],
    workflows: [{ binding: "WORKFLOW", class_name: "FixtureWorkflow", name: "workflow" }],
  };
  const bindings = unstable_convertConfigBindingsToStartWorkerBindings(config as never);

  const typedBindings = Object.values(bindings) as Array<{ [key: string]: unknown; type: string }>;
  const bindingTypes = typedBindings.map((binding) => binding.type);

  expect([...new Set(bindingTypes)].sort()).toEqual([
    "agent_memory",
    "ai",
    "ai_search",
    "ai_search_namespace",
    "analytics_engine",
    "artifacts",
    "assets",
    "browser",
    "d1",
    "data_blob",
    "dispatch_namespace",
    "durable_object_namespace",
    "flagship",
    "hyperdrive",
    "images",
    "json",
    "kv_namespace",
    "logfwdr",
    "media",
    "mtls_certificate",
    "pipeline",
    "plain_text",
    "queue",
    "r2_bucket",
    "ratelimit",
    "secrets_store_secret",
    "send_email",
    "service",
    "stream",
    "text_blob",
    "unsafe_custom",
    "unsafe_hello_world",
    "vectorize",
    "version_metadata",
    "vpc_network",
    "vpc_service",
    "wasm_module",
    "websearch",
    "worker_loader",
    "workflow",
  ]);
  expect(
    [
      ...new Set(
        typedBindings
          .filter((binding) => isSupportedSlotBinding(binding, new Set(["binding-catalog", "service"])))
          .map((binding) => binding.type),
      ),
    ].sort(),
  ).toEqual(["d1", "durable_object_namespace", "images", "json", "kv_namespace", "plain_text", "r2_bucket", "service"]);
  expect(
    canUseIsolatedWorkerSlots([
      {
        input: { config } as never,
        name: "binding-catalog",
      },
    ]),
  ).toBeFalse();
});
