import type { Message, Response } from "./types.js";
import type { Participant } from "./participant.js";

/**
 * Synchronous in-memory message hub. Tests use it to drop messages (node
 * down / unreachable) and to duplicate deliveries (at-least-once networks).
 */
export class Hub {
  private nodes = new Map<string, Participant>();
  private down = new Set<string>();
  /** Number of extra times every message is delivered (default 0). */
  duplicates = 0;

  register(participant: Participant): void {
    this.nodes.set(participant.id, participant);
  }

  unregister(id: string): void {
    this.nodes.delete(id);
  }

  setDown(id: string, isDown: boolean): void {
    if (isDown) this.down.add(id);
    else this.down.delete(id);
  }

  /** Returns null when the destination is unreachable. */
  send(to: string, msg: Message): Response | null {
    const node = this.nodes.get(to);
    if (!node || this.down.has(to)) return null;
    let response: Response | null = null;
    for (let i = 0; i <= this.duplicates; i++) {
      response = node.handle(msg);
    }
    return response;
  }
}
