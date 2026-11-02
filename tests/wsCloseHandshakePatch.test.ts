import { bunFixtureTest, fixturePath } from "./fixtureRunner";

// Isolate module mocks from setup's alternative WebSocket compatibility implementation.
const fixture = bunFixtureTest(fixturePath(import.meta.dir, "ws-close-handshake"));

fixture.test(
  "ws module exports preserve the server close code and reason",
  ({ run }) => {
    run({ timeoutMs: 10_000, processTimeoutMs: 20_000 }).expectStatusCode(0);
  },
  30_000,
);
