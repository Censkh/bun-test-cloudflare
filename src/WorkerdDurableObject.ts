export const runObjectName = (runId: string, name: string) => JSON.stringify([runId, name]);

export type RunDurableObjectTarget =
  | { kind: "named"; name: string }
  | { kind: "unique"; token: string }
  | { kind: "hex"; hex: string };

export type RunDurableObjectOperation =
  | { method: "fetch"; target: RunDurableObjectTarget; request: Request }
  | { method: "rpc"; target: RunDurableObjectTarget; prop: string; args: unknown[] };

export function createRunDurableObjectNamespace(
  invoke: (operation: RunDurableObjectOperation) => Promise<unknown>,
  fetchVia?: (target: RunDurableObjectTarget, request: Request) => Promise<Response>,
): DurableObjectNamespace {
  const targetPrefix = "__btcf_do:";
  const targets = new WeakMap<object, RunDurableObjectTarget>();
  const encodeTarget = (target: RunDurableObjectTarget) =>
    target.kind === "hex" ? target.hex : `${targetPrefix}${JSON.stringify(target)}`;
  const decodeTarget = (id: string): RunDurableObjectTarget =>
    id.startsWith(targetPrefix)
      ? (JSON.parse(id.slice(targetPrefix.length)) as RunDurableObjectTarget)
      : { kind: "hex", hex: id };
  const makeId = (target: RunDurableObjectTarget): DurableObjectId => {
    const serialized = encodeTarget(target);
    const id: DurableObjectId = {
      name: target.kind === "named" ? target.name : undefined,
      toString: () => serialized,
      equals: (other: DurableObjectId) => other.toString() === serialized,
    };
    targets.set(id, target);
    return id;
  };
  const createStub = (id: DurableObjectId): DurableObjectStub => {
    const target = targets.get(id) ?? decodeTarget(id.toString());
    return new Proxy({} as DurableObjectStub, {
      get(_unused, property) {
        if (property === "id") return id;
        if (property === "name") return id.name;
        if (property === "then" || property === "catch" || property === "finally" || typeof property === "symbol") {
          return undefined;
        }
        if (property === "fetch") {
          return (input: RequestInfo | URL, init?: RequestInit) => {
            const request = input instanceof Request && init === undefined ? input : new Request(input, init);
            if (fetchVia) return fetchVia(target, request);
            return invoke({ method: "fetch", target, request }) as Promise<Response>;
          };
        }
        return (...args: unknown[]) => invoke({ method: "rpc", target, prop: String(property), args });
      },
    });
  };

  const namespace: DurableObjectNamespace = {
    newUniqueId: () => makeId({ kind: "unique", token: crypto.randomUUID() }),
    idFromName: (name: string) => makeId({ kind: "named", name }),
    idFromString: (hex: string) => makeId(decodeTarget(hex)),
    get: (id: DurableObjectId) => createStub(id),
    getByName: (name: string) => createStub(makeId({ kind: "named", name })),
    jurisdiction: () => namespace,
  } as unknown as DurableObjectNamespace;

  return namespace;
}

/** Encodes a run-scoped name that preserves whether the caller used idFromName or newUniqueId. */
export const encodeScopedObjectName = (
  runId: string,
  target: Extract<RunDurableObjectTarget, { kind: "named" | "unique" }>,
) => runObjectName(runId, JSON.stringify(target.kind === "named" ? ["n", target.name] : ["u", target.token]));

/** Decodes ctx.id.name inside a native fenced Durable Object back into runId and original name. */
export const parseRunObjectIdentity = (
  rawName: string | undefined,
): { runId: string; name: string | undefined } | undefined => {
  if (!rawName) return undefined;
  try {
    const [runId, inner] = JSON.parse(rawName) as [string, string];
    if (typeof runId !== "string" || typeof inner !== "string") return undefined;
    const [kind, value] = JSON.parse(inner) as [string, string];
    if (kind === "n") return { runId, name: value };
    if (kind === "u") return { runId, name: undefined };
    return { runId, name: inner };
  } catch {
    return undefined;
  }
};

type FencedNativeStub = DurableObjectStub & {
  __btcf_rpc(prop: string, args: unknown[]): Promise<unknown>;
  __btcf_destroy(): Promise<void>;
};

export async function executeRunDurableObjectOperation(
  namespace: DurableObjectNamespace,
  runId: string,
  operation: RunDurableObjectOperation,
  onTouch?: (nativeIdHex: string) => void,
): Promise<unknown> {
  const nativeId =
    operation.target.kind === "hex"
      ? namespace.idFromString(operation.target.hex)
      : namespace.idFromName(encodeScopedObjectName(runId, operation.target));
  onTouch?.(nativeId.toString());
  const stub = namespace.get(nativeId) as unknown as FencedNativeStub;
  if (operation.method === "fetch") {
    return stub.fetch(operation.request);
  }
  return stub.__btcf_rpc(operation.prop, operation.args);
}

/** Reclaims storage and cancels alarms on every native Durable Object instance touched by a retired run. */
export async function clearRunDurableObjects(
  namespaces: Record<string, DurableObjectNamespace>,
  touched: Map<string, Set<string>>,
): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  for (const [bindingName, ids] of touched) {
    const namespace = namespaces[bindingName];
    if (!namespace) continue;
    for (const hex of ids) {
      const stub = namespace.get(namespace.idFromString(hex)) as unknown as FencedNativeStub;
      tasks.push(stub.__btcf_destroy().catch(() => {}));
    }
  }
  await Promise.all(tasks);
  touched.clear();
}
