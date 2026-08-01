import { expect, test } from "bun:test";

test("bun-test-cloudflare setup can load Undici 6", () => {
  const packageJson = require("undici/package.json");
  const undici = require("undici");

  expect(packageJson.version).toStartWith("6.");
  expect(typeof undici.fetch).toBe("function");
  expect(typeof undici.Request).toBe("function");
  expect(typeof undici.Response).toBe("function");
  expect(typeof undici.Headers).toBe("function");
  expect(typeof undici.FormData).toBe("function");
  expect(typeof undici.caches.open).toBe("function");
});
