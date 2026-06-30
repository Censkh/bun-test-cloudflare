import { Api, FetchRequestBackend, RequestEvent } from "api-def";
import { getCloudflareHarnessRunContext } from "bun-test-cloudflare";

const fetchBackend = (input: RequestInfo | URL, init?: RequestInit) => {
  const { workers } = getCloudflareHarnessRunContext<any>();
  return workers.BACKEND.fetch(input as any, init as any) as Promise<Response>;
};

export const createClient = () => {
  const api = new Api({
    baseUrl: "https://example.com",
    middleware: [
      {
        beforeSend: (context: any) => {
          context.updateHeaders({ "X-Fixture-Auth": "ok" });
        },
      },
      {
        [RequestEvent.ERROR]: (context: any) => {
          if (context.error) throw context.error;
        },
      },
    ],
    name: "Fixture API",
    requestBackend: new FetchRequestBackend(((input: any, init: any) => fetchBackend(input, init)) as any),
  });

  const postAsset = api
    .endpoint()
    .bodyOf<any>({ encoding: "multipart/form-data" })
    .responseOf<any>()
    .build({ id: "postAsset", method: "post", path: "/asset" });

  return {
    assets: {
      async create(options: { content?: { base64: string; type: string }; metadata?: Array<{ name: string; type: string; value: unknown }>; name?: string }) {
        if (!options.content) {
          throw new Error("Either file content, URL, or multipart part is required");
        }
        if (!options.name) {
          throw new Error("Asset name is required");
        }

        const metadata = options.metadata
          ? Object.fromEntries(options.metadata.map((item, index) => [index, item]))
          : undefined;
        const result = await postAsset.submit({
          body: {
            name: options.name,
            content: options.content,
            ...(metadata ? { metadata } : {}),
          },
        });
        return result.data;
      },
    },
  };
};
