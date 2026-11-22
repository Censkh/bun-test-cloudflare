import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

type Env = { KV: KVNamespace; RECORD: Workflow };

// Records its params, under its own instance ID, through its run's KV.
export class RecordWorkflow extends WorkflowEntrypoint<Env, { value: string }> {
  async run(event: WorkflowEvent<{ value: string }>, step: WorkflowStep) {
    return step.do("record", async () => {
      await this.env.KV.put(`recorded:${event.instanceId}`, event.payload.value);
      return { instanceId: event.instanceId, value: event.payload.value };
    });
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const { id, value } = (await request.json()) as { id: string; value: string };
    const instance = await env.RECORD.create({ id, params: { value } });
    return Response.json({ id: instance.id });
  },
};
