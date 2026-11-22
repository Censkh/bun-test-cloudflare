import { WorkerEntrypoint } from "cloudflare:workers";

// RPC methods another Worker calls through its service binding.
export default class Target extends WorkerEntrypoint<{ LABEL: string }> {
  label(value: string) {
    return `${this.env.LABEL}: ${value}`;
  }

  // Reads its input through the caller's callback, as the media Worker reads a caller's media.
  async describe(read: (part: number) => Promise<string>) {
    return `${this.env.LABEL}: ${await read(1)}${await read(2)}`;
  }
}
