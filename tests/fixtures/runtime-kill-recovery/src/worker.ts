import { DurableObject } from "cloudflare:workers";

export class Counter extends DurableObject {
  async increment() {
    const value = ((await this.ctx.storage.get<number>("value")) ?? 0) + 1;
    await this.ctx.storage.put("value", value);
    return value;
  }
}

export default {
  fetch() {
    return new Response("ok");
  },
};
