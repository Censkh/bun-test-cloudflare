const webStreamClosedPromiseSymbol = Symbol.for("nodejs.webstream.isClosedPromise");
const neverClosedWebStream = { promise: new Promise<never>(() => {}) };

const patchWebStreamClosedPromiseFallback = (prototype: object) => {
  if (Object.hasOwn(prototype, webStreamClosedPromiseSymbol)) {
    return;
  }

  Object.defineProperty(prototype, webStreamClosedPromiseSymbol, {
    configurable: true,
    get() {
      return neverClosedWebStream;
    },
  });
};

export const installWebStreamPatch = () => {
  const NativeReadableStream = globalThis.ReadableStream;
  const NativeWritableStream = globalThis.WritableStream;

  class ReadableStreamWithClosedPromise<R = unknown> extends NativeReadableStream<R> {
    constructor(underlyingSource?: UnderlyingSource<R>, strategy?: QueuingStrategy<R>) {
      let resolveClosed!: () => void;
      let rejectClosed!: (error: unknown) => void;
      const closedPromise = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });

      const source =
        underlyingSource && typeof underlyingSource === "object"
          ? {
              ...underlyingSource,
              start(controller: ReadableStreamController<R>) {
                const originalClose = controller.close.bind(controller);
                const originalError = controller.error.bind(controller);
                controller.close = (...args: []) => {
                  const result = originalClose(...args);
                  resolveClosed();
                  return result;
                };
                controller.error = (error?: unknown) => {
                  const result = originalError(error);
                  rejectClosed(error);
                  return result;
                };
                return underlyingSource.start?.call(this, controller);
              },
              cancel(reason?: unknown) {
                resolveClosed();
                return underlyingSource.cancel?.call(this, reason);
              },
            }
          : underlyingSource;

      super(source, strategy);
      Object.defineProperty(this, webStreamClosedPromiseSymbol, {
        configurable: true,
        value: { promise: closedPromise },
      });
    }
  }

  class WritableStreamWithClosedPromise<W = unknown> extends NativeWritableStream<W> {
    constructor(underlyingSink?: UnderlyingSink<W>, strategy?: QueuingStrategy<W>) {
      let resolveClosed!: () => void;
      let rejectClosed!: (error: unknown) => void;
      const closedPromise = new Promise<void>((resolve, reject) => {
        resolveClosed = resolve;
        rejectClosed = reject;
      });

      const sink =
        underlyingSink && typeof underlyingSink === "object"
          ? {
              ...underlyingSink,
              close() {
                resolveClosed();
                return underlyingSink.close?.call(this);
              },
              abort(reason?: unknown) {
                rejectClosed(reason);
                return underlyingSink.abort?.call(this, reason);
              },
            }
          : underlyingSink;

      super(sink, strategy);
      Object.defineProperty(this, webStreamClosedPromiseSymbol, {
        configurable: true,
        value: { promise: closedPromise },
      });
    }
  }

  globalThis.ReadableStream = ReadableStreamWithClosedPromise as typeof ReadableStream;
  globalThis.WritableStream = WritableStreamWithClosedPromise as typeof WritableStream;
  patchWebStreamClosedPromiseFallback(NativeReadableStream.prototype);
  patchWebStreamClosedPromiseFallback(NativeWritableStream.prototype);
};
