import { DurableObject } from "cloudflare:workers";

type Env = {
  SERVICE: Fetcher;
};

let requestCount = 0;

export class SlotCounter extends DurableObject {
  async fetch() {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return Response.json({ count });
  }
}

export default {
  async fetch(_request: Request, env: Env) {
    requestCount += 1;
    const serviceResponse = (await (await env.SERVICE.fetch("https://service.invalid/")).json()) as {
      requestCount: number;
    };
    return Response.json({ requestCount, serviceRequestCount: serviceResponse.requestCount });
  },
};
