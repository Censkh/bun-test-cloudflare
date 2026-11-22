import { DurableObject } from "cloudflare:workers";

type Env = {
  SERVICE: Fetcher;
};

export class SlotCounter extends DurableObject {
  // The calls it has started, in the order they started.
  #started: number[] = [];

  record(value: number) {
    this.#started.push(value);
  }

  started() {
    return this.#started;
  }

  // Records each value after awaits that are already settled, as a batch's messages are each sent
  // after checks that need no I/O.
  async recordEach(values: number[]) {
    for (const value of values) {
      await Promise.resolve();
      await Promise.allSettled([Promise.resolve()]);
      this.#started.push(value);
    }
  }

  async fetch() {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return Response.json({ count });
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    // The slot's other Worker answers through its service binding.
    const service = (await (await env.SERVICE.fetch("https://service.invalid/")).json()) as { answered: boolean };
    return Response.json({ serviceAnswered: service.answered });
  },
};
