import { expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("bun-test-cloudflare setup can load Undici 8", () => {
  const packageJson = require("undici/package.json");
  const undici = require("undici");

  expect(packageJson.version).toStartWith("8.");
  expect(typeof undici.fetch).toBe("function");
  expect(typeof undici.Request).toBe("function");
  expect(typeof undici.Response).toBe("function");
  expect(typeof undici.Headers).toBe("function");
  expect(typeof undici.FormData).toBe("function");
  expect(typeof undici.caches.open).toBe("function");
});
