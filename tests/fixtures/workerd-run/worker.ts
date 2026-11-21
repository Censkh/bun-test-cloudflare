import { DurableObject } from "cloudflare:workers";
import {
  dispatchRunQueue,
  getRunAlarmOwner,
  loadRunWorker,
  RunBindingCapability,
  RunBindingProxy,
  type RunOperation,
  type RunQueueBody,
  runEnded,
  runObjectName,
  runQueueMessage,
  setRunAlarm,
} from "bun-test-cloudflare/workerd";

type Env = {
  DB: D1Database;
  LOADER: WorkerLoader;
  OBSERVED: KVNamespace;
  SLOTS: DurableObjectNamespace<Slot>;
  ALARMS: DurableObjectNamespace<Alarm>;
  QUEUE: Queue<RunQueueBody<{ slot: string }>>;
};

export { RunBindingCapability };

export class Slot extends RunBindingProxy<Env> {
  protected async resetBindings() {
    await this.env.DB.prepare("DELETE FROM effects WHERE slot = ?").bind(this.ctx.id.name).run();
  }

  protected async perform({ name, args }: RunOperation, runId: string) {
    if (name === "held-effect") {
      await this.env.OBSERVED.put("admitted", "true");
      while ((await this.env.OBSERVED.get("release")) === null) {
        await scheduler.wait(20);
      }
      name = "effect";
    }
    const slot = this.ctx.id.name!;
    if (name === "effect") {
      await this.env.DB.prepare("INSERT INTO effects VALUES (?, ?, ?)").bind(slot, runId, args[0]).run();
    } else if (name === "queue") {
      await this.env.QUEUE.send(runQueueMessage(runId, { slot }), {
        contentType: "v8",
        delaySeconds: Number(args[0]),
      });
    } else if (name === "alarm") {
      await this.env.ALARMS.getByName(runObjectName(runId, slot)).schedule(runId, slot, Number(args[0]));
    } else {
      throw new Error("Unknown binding operation");
    }
  }
}

export class Alarm extends DurableObject<Env> {
  async schedule(runId: string, slot: string, delay: number) {
    await this.ctx.storage.put("slot", slot);
    await setRunAlarm(this.ctx.storage, runId, Date.now() + delay);
  }

  async alarm() {
    const [runId, slot] = await Promise.all([getRunAlarmOwner(this.ctx.storage), this.ctx.storage.get<string>("slot")]);
    if (!runId || !slot) throw new Error("Missing alarm owner");
    try {
      await this.env.SLOTS.getByName(slot).invoke(runId, { name: "effect", args: ["alarm"] });
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes(runEnded)) throw error;
      await this.env.OBSERVED.put(`${runId}/alarm`, "rejected");
    }
  }
}

const child = `
let requests = 0;
export default {
  async fetch(request, env, ctx) {
    const { delay } = await request.json();
    if (delay !== null) {
      await env.BINDINGS.invoke("queue", delay ? 2 : 0);
      await env.BINDINGS.invoke("alarm", delay ? 1800 : 0);
      if (!delay) ctx.waitUntil(env.BINDINGS.invoke("effect", "waitUntil"));
    }
    return Response.json(++requests);
  },
};
`;

export default {
  async fetch(request, env, ctx) {
    const [, action, slot, runId] = new URL(request.url).pathname.split("/");
    const proxy = env.SLOTS.getByName(slot);
    if (action === "activate") {
      await proxy.activate(runId);
      return new Response(null, { status: 204 });
    }
    if (!(await proxy.isActive(runId))) return new Response(null, { status: 410 });
    const capability = ctx.exports.RunBindingCapability({ props: { runId, proxy } });
    if (action === "hold-write") {
      await capability.invoke("held-effect", "held");
      return new Response(null, { status: 204 });
    }
    if (action === "hold") {
      ctx.waitUntil(
        (async () => {
          // Hold native background work until the test confirms that the slot has been reassigned.
          while ((await env.OBSERVED.get("rotated")) === null) {
            await scheduler.wait(20);
          }
          try {
            await capability.invoke("effect", "waitUntil");
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes(runEnded)) throw error;
            await env.OBSERVED.put(`${runId}/waitUntil`, "rejected");
          }
        })(),
      );
      return new Response(null, { status: 204 });
    }
    return loadRunWorker(env.LOADER, runId, "fixture", () => ({
      compatibilityDate: "2026-09-09",
      mainModule: "worker.js",
      modules: { "worker.js": child },
      globalOutbound: null,
      env: {
        BINDINGS: capability,
      },
    }))
      .getEntrypoint()
      .fetch(request);
  },

  async queue(batch, env) {
    const slots = new Map(batch.messages.map(({ body }) => [body.runId, body.body.slot]));
    await dispatchRunQueue(
      batch,
      async (runId) => {
        const active = await env.SLOTS.getByName(slots.get(runId)!).isActive(runId);
        if (!active) await env.OBSERVED.put(`${runId}/queue`, "rejected");
        return active;
      },
      async (runId, { messages }) => {
        for (const message of messages) {
          await env.SLOTS.getByName(message.body.slot).invoke(runId, { name: "effect", args: ["queue"] });
        }
      },
    );
  },
} satisfies ExportedHandler<Env, RunQueueBody<{ slot: string }>>;
