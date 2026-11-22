import { DurableObject } from "cloudflare:workers";

type Env = {
  SERVICE: Fetcher;
};

export class SlotCounter extends DurableObject {
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
