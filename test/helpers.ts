import type { CacheEntry, LoaderResult } from "../src/types.js";
import { MISS } from "../src/types.js";
import { MemoryL2Store, type L2Store } from "../src/stores.js";

export class VirtualClock {
  time = 0;

  now = (): number => this.time;

  advance(ms: number): void {
    this.time += ms;
  }
}

interface PendingLoad<K, V> {
  readonly key: K;
  readonly id: number;
  readonly resolve: (value: LoaderResult<V>) => void;
  readonly reject: (error: unknown) => void;
}

export class ControlledLoader<K, V = string> {
  private readonly pending: PendingLoad<K, V>[] = [];
  private readonly calls = new Map<K, number>();

  load = (key: K): Promise<LoaderResult<V>> => {
    const id = (this.calls.get(key) ?? 0) + 1;
    this.calls.set(key, id);
    return new Promise<LoaderResult<V>>((resolve, reject) => {
      this.pending.push({ key, id, resolve, reject });
    });
  };

  callsFor(key: K): number {
    return this.calls.get(key) ?? 0;
  }

  pendingFor(key: K): number {
    return this.pending.filter((entry) => Object.is(entry.key, key)).length;
  }

  pendingKeys(): K[] {
    const keys: K[] = [];
    for (const entry of this.pending) {
      if (!keys.some((key) => Object.is(key, entry.key))) {
        keys.push(entry.key);
      }
    }
    return keys;
  }

  resolve(key: K, value: LoaderResult<V>): number {
    return this.settle(key, () => value);
  }

  resolveWith(key: K, makeValue: (id: number) => LoaderResult<V>): number {
    return this.settle(key, makeValue);
  }

  reject(key: K, error: unknown): number {
    let count = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (Object.is(entry.key, key)) {
        this.pending.splice(index, 1);
        entry.reject(error);
        count += 1;
      }
    }
    return count;
  }

  private settle(key: K, makeValue: (id: number) => LoaderResult<V>): number {
    let count = 0;
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const entry = this.pending[index];
      if (Object.is(entry.key, key)) {
        this.pending.splice(index, 1);
        entry.resolve(makeValue(entry.id));
        count += 1;
      }
    }
    return count;
  }
}

export async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await Promise.resolve();
  }
}

export class GatedL2Store<K, V> implements L2Store<K, V> {
  readonly inner = new MemoryL2Store<K, V>();
  sets = 0;
  deletes = 0;

  private gateNextSet = false;
  private releaseSet: (() => void) | undefined;
  private setEntered: (() => void) | undefined;
  private entered: Promise<void> = Promise.resolve();
  private gateNextGet = false;
  private releaseGet: (() => void) | undefined;
  private getEntered: (() => void) | undefined;
  private getEnteredPromise: Promise<void> = Promise.resolve();

  armSetGate(): void {
    this.gateNextSet = true;
    this.entered = new Promise<void>((resolve) => {
      this.setEntered = resolve;
    });
  }

  armGetGate(): void {
    this.gateNextGet = true;
    this.getEnteredPromise = new Promise<void>((resolve) => {
      this.getEntered = resolve;
    });
  }

  async get(key: K): Promise<CacheEntry<V> | undefined> {
    if (this.gateNextGet) {
      this.gateNextGet = false;
      this.getEntered?.();
      await new Promise<void>((resolve) => {
        this.releaseGet = resolve;
      });
    }
    return this.inner.get(key);
  }

  async set(key: K, entry: CacheEntry<V>): Promise<void> {
    this.sets += 1;
    if (this.gateNextSet) {
      this.gateNextSet = false;
      this.setEntered?.();
      await new Promise<void>((resolve) => {
        this.releaseSet = resolve;
      });
    }
    this.inner.set(key, entry);
  }

  delete(key: K): void {
    this.deletes += 1;
    this.inner.delete(key);
  }

  writesFor(key: K): number {
    return this.inner.writesFor(key);
  }

  async waitForSetToStart(): Promise<void> {
    await this.entered;
  }

  releaseSetWrite(): void {
    this.releaseSet?.();
  }

  async waitForGetToStart(): Promise<void> {
    await this.getEnteredPromise;
  }

  releaseGetRead(): void {
    this.releaseGet?.();
  }
}

export function valueOf<V>(entry: CacheEntry<V> | undefined): V | undefined {
  return entry?.kind === "value" ? entry.value : undefined;
}

export function isNegative(entry: CacheEntry<unknown> | undefined): boolean {
  return entry?.kind === "negative";
}

export { MISS };
