import { bunFixtureTest, fixturePath } from "./fixtureRunner";

const fixture = bunFixtureTest(fixturePath(import.meta.dir, "workerd-run"));

fixture.test("Workerd fences delayed operations and loads fresh modules in reused slots", ({ run }) => {
  run({ logOutput: true }).expectStatusCode(0);
});
