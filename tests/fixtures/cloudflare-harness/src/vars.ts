export default {
  fetch: (_request: Request, env: { GREETING: string }) => new Response(env.GREETING),
};
