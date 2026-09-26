type Env = {
  KV: KVNamespace;
};

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/cookies": {
        const headers = new Headers({ "Content-Type": "text/plain" });
        headers.append("Set-Cookie", "first=1; Path=/");
        headers.append("Set-Cookie", "second=2; Path=/; HttpOnly");
        return new Response("cookies", { headers });
      }
      case "/redirect":
        return new Response(null, {
          status: 302,
          headers: { Location: "/landed", "Set-Cookie": "redirected=1; Path=/" },
        });
      case "/echo":
        return Response.json({
          method: request.method,
          url: request.url,
          header: request.headers.get("x-test"),
          body: await request.text(),
        });
      case "/stream": {
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(encoder.encode("first;"));
            await new Promise((resolve) => setTimeout(resolve, 750));
            controller.enqueue(encoder.encode("second"));
            controller.close();
          },
        });
        return new Response(stream, { headers: { "Content-Type": "text/plain" } });
      }
      case "/ws": {
        if (request.headers.get("Upgrade") !== "websocket") {
          return new Response("Expected websocket", { status: 426 });
        }
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        server.accept();
        // Sent before the client has necessarily finished connecting
        server.send("hello");
        server.addEventListener("message", (event) => {
          if (event.data === "close") {
            server.close(4000, "closed by worker");
            return;
          }
          server.send(`echo:${event.data}`);
        });
        return new Response(null, { status: 101, webSocket: client });
      }
      case "/no-content":
        return new Response(null, { status: 204 });
      case "/kv":
        return new Response((await env.KV.get(url.searchParams.get("key") ?? "")) ?? "missing");
    }

    return new Response("not found", { status: 404 });
  },
};
