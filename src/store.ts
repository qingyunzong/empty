import type { Item } from './types';

export class DataStore {
  private readonly items = new Map<string, Item>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  upsert(item: Item): void {
    this.items.set(item.id, item);
    this.bump();
  }

  remove(id: string): void {
    if (this.items.delete(id)) {
      this.bump();
    }
  }

  snapshot(): Item[] {
    return [...this.items.values()];
  }

  get dataVersion(): number {
    return this.version;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private bump(): void {
    this.version += 1;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
