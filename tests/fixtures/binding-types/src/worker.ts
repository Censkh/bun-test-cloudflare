import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export class Counter extends DurableObject {
  async fetch() {
    const count = ((await this.ctx.storage.get<number>("count")) ?? 0) + 1;
    await this.ctx.storage.put("count", count);
    return Response.json({ count });
  }
}

export class FixtureWorkflow extends WorkflowEntrypoint {
  async run(_event: WorkflowEvent<unknown>, step: WorkflowStep) {
    return step.do("complete fixture", () => ({ complete: true }));
  }
}

export default {
  fetch() {
    return new Response("binding-types");
  },
};
