import { afterAll, beforeEach } from "bun:test";

let runningTests = 0;

/** Counts running tests; the setup preload registers this around every test of the run. */
export const markTestStarted = () => {
  runningTests += 1;
};

export const markTestFinished = () => {
  runningTests = Math.max(0, runningTests - 1);
};

/**
 * Runs `callback` when the scope that is creating something ends: a test (or its `beforeEach`)
 * when called inside one, otherwise the describe block or file being collected. Bun runs an
 * `afterAll` registered inside a `beforeAll`, `afterAll` or `afterEach` as soon as that hook
 * returns, before the tests the hook prepares for, so nothing is registered there; Bun only
 * accepts new hooks while it collects a describe block or file, which is how those hooks are told
 * apart from collection. Returns whether `callback` was registered.
 */
export const onCreatingScopeEnd = (callback: () => Promise<void>): boolean => {
  if (runningTests === 0) {
    try {
      beforeEach(() => {});
    } catch {
      return false;
    }
  }
  try {
    afterAll(callback);
    return true;
  } catch {
    return false;
  }
};
