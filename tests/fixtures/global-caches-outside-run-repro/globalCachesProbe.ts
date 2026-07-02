export const probeGlobalCaches = () => {
  return globalThis.caches.default;
};

probeGlobalCaches();
