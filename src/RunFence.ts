let nextRunId = 0;

/** Owns the dispatch handles handed out for one use of a harness runtime. */
export class RunFence {
  readonly #id = ++nextRunId;
  readonly #pending = new Set<Promise<unknown>>();
  #retired = false;

  assertActive() {
    if (this.#retired) {
      const error = new Error(`Cloudflare harness run ${this.#id} has ended`);
      error.name = "CloudflareHarnessRunEnded";
      throw error;
    }
  }

  async dispatch<T>(operation: () => T | Promise<T>): Promise<T> {
    this.assertActive();
    const pending = Promise.resolve(operation());
    this.#pending.add(pending);
    try {
      return await pending;
    } finally {
      this.#pending.delete(pending);
    }
  }

  retire(): Promise<unknown> {
    this.#retired = true;
    return Promise.allSettled(this.#pending);
  }

  worker<T extends object>(handle: T): T {
    return Object.defineProperties(
      {},
      Object.fromEntries(
        Object.entries(Object.getOwnPropertyDescriptors(handle)).map(([name, descriptor]) => {
          const operation = descriptor.value;
          // Wrangler's WorkerHandle methods are asynchronous.
          if (typeof operation === "function") {
            descriptor.value = (...args: unknown[]) => this.dispatch(() => Reflect.apply(operation, handle, args));
          }
          return [name, descriptor];
        }),
      ),
    ) as T;
  }
}
