export default {
  async fetch(_request: Request, env: { CMS: Fetcher }) {
    return await env.CMS.fetch("https://cms.local/broken-module");
  },
};
