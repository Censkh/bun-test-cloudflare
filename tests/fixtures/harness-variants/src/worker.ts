import { DurableObject } from "cloudflare:workers";

type Env = { GREETING: string; GREETER: DurableObjectNamespace<Greeter>; JOBS: Queue<string>; KV: KVNamespace };

// Answers with the greeting its env has, and the one process.env has.
export class Greeter extends DurableObject<Env> {
  greeting() {
    return this.env.GREETING;
  }

  processGreeting() {
    return process.env.GREETING;
  }
}

// Worked out from the env once, as a client made on first use is.
let cachedGreeting: string | undefined;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/cached-greeting") {
      cachedGreeting ??= env.GREETING;
      return Response.json({ greeting: cachedGreeting });
    }
    if (url.pathname === "/greeting") return Response.json({ greeting: env.GREETING });
    if (url.pathname === "/object-greeting")
      return Response.json({ greeting: await env.GREETER.getByName("a").greeting() });
    if (url.pathname === "/object-process-greeting")
      return Response.json({ greeting: await env.GREETER.getByName("a").processGreeting() });
    if (url.pathname === "/send") {
      await env.JOBS.send(url.searchParams.get("value")!);
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  },
  // Records each message it consumes.
  async queue(batch: MessageBatch<string>, env: Env) {
    for (const message of batch.messages) await env.KV.put(`consumed:${message.body}`, "1");
  },
};
