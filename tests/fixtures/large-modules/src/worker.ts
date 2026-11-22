// large.ts is written by the test that runs this fixture: it makes the bundle more than an RPC
// value can hold.
import large from "./large";

export default {
  fetch() {
    return Response.json({ size: large.length, first: large[0], last: large[large.length - 1] });
  },
};
