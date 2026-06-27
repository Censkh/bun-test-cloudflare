import { DurableObject } from "cloudflare:workers";

type Env = {
  APP_EVENTS: DurableObjectNamespace<AppEvents>;
  CMS: Fetcher;
  COUNTER: DurableObjectNamespace<Counter>;
};

export class AppEvents extends DurableObject {
  private sockets = new Set<WebSocket>();

  publish(message: string) {
    for (const socket of this.sockets) {
      socket.send(message);
    }
    return this.sockets.size;
  }

  fetch(request: Request): Response {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected websocket", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.sockets.add(server);

    return new Response(null, { status: 101, webSocket: client });
  }
}

export class Counter extends DurableObject {
  async increment() {
    const current = (await this.ctx.storage.get<number>("count")) ?? 0;
    const next = current + 1;
    await this.ctx.storage.put("count", next);
    return next;
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/cms") {
      return env.CMS.fetch("https://cms-fixture.local/data");
    }
    if (url.pathname === "/events/subscribe") {
      const stub = env.APP_EVENTS.get(env.APP_EVENTS.idFromName("fixture"));
      return stub.fetch(request);
    }
    if (url.pathname === "/events/publish") {
      const stub = env.APP_EVENTS.get(env.APP_EVENTS.idFromName("fixture"));
      const sockets = await stub.publish(url.searchParams.get("message") ?? "fixture-message");
      return Response.json({ sockets });
    }
    if (url.pathname === "/counter") {
      const id = url.searchParams.get("id") ?? "default";
      const stub = env.COUNTER.get(env.COUNTER.idFromName(id));
      return Response.json({ count: await stub.increment() });
    }
    return new Response("backend-ok");
  },
};
