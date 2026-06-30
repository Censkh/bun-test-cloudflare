type Env = {
  IMAGES: ImagesBinding;
};

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    if (url.pathname === "/transform") {
      if (!request.body) {
        return new Response("missing body", { status: 400 });
      }

      const output = await env.IMAGES.input(request.body).output({ format: "image/webp" });
      return new Response(output.image(), {
        headers: { "content-type": "image/webp" },
      });
    }

    return new Response("ok");
  },
};
