import type { Conflict, Resolution, ResolutionChoice } from './types.js';

export class ResolutionStore {
  private readonly map = new Map<string, Resolution>();

  resolve(conflict: Conflict, choice: ResolutionChoice): void {
    this.map.set(conflict.key, { key: conflict.key, choice, signature: conflict.signature });
  }

  get(key: string): Resolution | undefined {
    return this.map.get(key);
  }

  revoke(key: string): boolean {
    return this.map.delete(key);
  }

  all(): Resolution[] {
    return [...this.map.values()];
  }

  get size(): number {
    return this.map.size;
  }

  toJSON(): string {
    return JSON.stringify(this.all(), null, 2);
  }

  static fromJSON(json: string): ResolutionStore {
    const store = new ResolutionStore();
    for (const r of JSON.parse(json) as Resolution[]) {
      store.map.set(r.key, r);
    }
    return store;
  }
}
