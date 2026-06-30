import cl100kBase from "tiktoken/encoders/cl100k_base";
import { init, Tiktoken } from "tiktoken/lite/init";
import wasm from "tiktoken/lite/tiktoken_bg.wasm";

let initPromise: Promise<void> | undefined;

const initTiktoken = () => {
  initPromise ??= init((imports) => WebAssembly.instantiate(wasm, imports));
  return initPromise;
};

export default {
  async fetch(request: Request): Promise<Response> {
    await initTiktoken();

    const url = new URL(request.url);
    const text = url.searchParams.get("text") ?? "hello world";
    const encoder = new Tiktoken(cl100kBase.bpe_ranks, cl100kBase.special_tokens, cl100kBase.pat_str);

    try {
      const tokens = encoder.encode(text);
      return Response.json({ tokenCount: tokens.length, tokens: Array.from(tokens) });
    } finally {
      encoder.free();
    }
  },
};
