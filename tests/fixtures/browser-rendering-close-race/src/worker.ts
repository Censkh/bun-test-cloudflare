import puppeteer from "@cloudflare/puppeteer";

const render = async (env: { BROWSER: Fetcher }) => {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setContent("<html><body>browser rendering close race</body></html>");
    await page.title();
  } finally {
    await browser.close();
  }
};

export default {
  async fetch(_request: Request, env: { BROWSER: Fetcher }, ctx: ExecutionContext) {
    const url = new URL(_request.url);

    if (url.searchParams.has("await")) {
      await render(env);
      return Response.json({ ok: true });
    }

    ctx.waitUntil(
      render(env)
        .then(() => console.log("browser rendered"))
        .catch((error) => console.error(error)),
    );

    return Response.json({ ok: true });
  },
};
