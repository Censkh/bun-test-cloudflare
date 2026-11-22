// A Workflow binding a fenced slot's run uses. Each slot has its own copy of every Workflow (its
// name suffixed for the slot, its class wrapped in the slot's host Worker), and each run's instances
// are kept apart within it: an instance's ID is scoped to its run, and its params carry the run, so
// the wrapper builds the Workflow with that run's bindings. The run sees only its own IDs.

/** The params a run's instance is created with: the run, and the params it was given. */
export type RunWorkflowParams = { __btcf_run: string; params: unknown };

type CreateOptions = { id?: string; params?: unknown; retention?: unknown };

export type RunWorkflowOperation =
  | { method: "create"; options?: CreateOptions }
  | { method: "createBatch"; batch: CreateOptions[] }
  | { method: "get"; id: string }
  | { method: "instance"; id: string; action: "pause" | "restart" | "resume" | "status" | "terminate" }
  | { method: "sendEvent"; id: string; event: { payload?: unknown; type: string } };

// Instance IDs take letters, digits, - and _ (at most 100 characters): a run's ID is reduced to
// those, and ends at the first _, which the run's own IDs may contain after it.
const runPrefix = (runId: string) => `btcf${runId.replace(/[^A-Za-z0-9-]/g, "").slice(0, 32)}_`;

/** A run's instance ID as the slot's Workflow knows it. */
export const scopeRunWorkflowInstanceId = (runId: string, id: string) => `${runPrefix(runId)}${id}`;

/** The run's own instance ID, from the one the slot's Workflow knows. */
export const unscopeRunWorkflowInstanceId = (scopedId: string) =>
  scopedId.startsWith("btcf") && scopedId.includes("_") ? scopedId.slice(scopedId.indexOf("_") + 1) : scopedId;

const instanceHandle = (invoke: (operation: RunWorkflowOperation) => Promise<unknown>, id: string) => ({
  id,
  pause: () => invoke({ method: "instance", id, action: "pause" }) as Promise<void>,
  restart: () => invoke({ method: "instance", id, action: "restart" }) as Promise<void>,
  resume: () => invoke({ method: "instance", id, action: "resume" }) as Promise<void>,
  sendEvent: (event: { payload?: unknown; type: string }) =>
    invoke({ method: "sendEvent", id, event }) as Promise<void>,
  status: () => invoke({ method: "instance", id, action: "status" }) as Promise<InstanceStatus>,
  terminate: () => invoke({ method: "instance", id, action: "terminate" }) as Promise<void>,
});

/** The Workflow binding a run's code is given, each call made through `invoke`. */
export function createRunWorkflowBinding(invoke: (operation: RunWorkflowOperation) => Promise<unknown>) {
  return {
    create: async (options?: CreateOptions) => {
      const { id } = (await invoke({ method: "create", options })) as { id: string };
      return instanceHandle(invoke, id);
    },
    createBatch: async (batch: CreateOptions[]) => {
      const ids = (await invoke({ method: "createBatch", batch })) as Array<{ id: string }>;
      return ids.map(({ id }) => instanceHandle(invoke, id));
    },
    get: async (id: string) => {
      await invoke({ method: "get", id });
      return instanceHandle(invoke, id);
    },
  } as unknown as Workflow;
}

const scopedCreate = (runId: string, options: CreateOptions | undefined) => {
  const id = options?.id ?? crypto.randomUUID();
  return {
    ...options,
    id: scopeRunWorkflowInstanceId(runId, id),
    params: { __btcf_run: runId, params: options?.params } satisfies RunWorkflowParams,
  };
};

/**
 * Carries out a run's Workflow call on the slot's Workflow, as the run's own IDs, recording each
 * instance it creates (`created`) so the slot can stop them when the run is retired.
 */
export async function executeRunWorkflowOperation(
  workflow: Workflow,
  runId: string,
  operation: RunWorkflowOperation,
  created: (scopedId: string) => unknown = () => {},
): Promise<unknown> {
  if (operation.method === "create") {
    const options = scopedCreate(runId, operation.options);
    await created(options.id);
    await workflow.create(options as never);
    return { id: unscopeRunWorkflowInstanceId(options.id) };
  }
  if (operation.method === "createBatch") {
    const batch = operation.batch.map((options) => scopedCreate(runId, options));
    for (const options of batch) await created(options.id);
    await workflow.createBatch(batch as never);
    return batch.map((options) => ({ id: unscopeRunWorkflowInstanceId(options.id) }));
  }
  const instance = await workflow.get(scopeRunWorkflowInstanceId(runId, operation.id));
  if (operation.method === "get") return { id: operation.id };
  if (operation.method === "sendEvent") return instance.sendEvent(operation.event as never);
  return (instance as unknown as Record<string, () => Promise<unknown>>)[operation.action]!();
}

/** Stops the instances a retired run created, whatever state they are in. */
export async function terminateRunWorkflows(workflows: Record<string, Workflow>, created: Map<string, Set<string>>) {
  await Promise.all(
    [...created].flatMap(([binding, ids]) =>
      [...ids].map(async (id) => {
        try {
          await (await workflows[binding]!.get(id)).terminate();
        } catch {
          // Finished, errored or never started: nothing of it runs on.
        }
      }),
    ),
  );
  created.clear();
}
