export default {
  fetch() {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("ok"));
            controller.close();
          }, 5);
        },
      }),
    );
  },
};
