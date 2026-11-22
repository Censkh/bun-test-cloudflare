import { DurableObject } from "cloudflare:workers";

type Target = { describe(read: (part: number) => Promise<string>): Promise<string> };
type Env = { RELAY: DurableObjectNamespace<Relay>; TARGET: Target };

const read = async (part: number) => `part${part}`;

// Calls the target from a Durable Object too.
export class Relay extends DurableObject<Env> {
  describe() {
    return this.env.TARGET.describe(read);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const fromObject = new URL(request.url).pathname === "/object";
    return Response.json({
      described: fromObject ? await env.RELAY.getByName("a").describe() : await env.TARGET.describe(read),
    });
  },
};
