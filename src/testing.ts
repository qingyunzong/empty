import type { ComputeFn } from "./coalescer.js";

export interface PendingCall<T> {
  readonly key: string;
  readonly signal: AbortSignal;
  readonly settled: boolean;
  resolve(value: T): void;
  reject(error: unknown): void;
}

/**
 * Controllable executor: records every invocation of the compute function and
 * lets the test decide exactly when each call resolves or rejects.
 */
export class ManualExecutor<T> {
  readonly calls: PendingCall<T>[] = [];

  readonly compute: ComputeFn<T> = (key, signal) =>
    new Promise<T>((resolve, reject) => {
      const record = {
        key,
        signal,
        settled: false,
        resolve(value: T): void {
          record.settled = true;
          resolve(value);
        },
        reject(error: unknown): void {
          record.settled = true;
          reject(error);
        },
      };
      this.calls.push(record);
    });

  get callCount(): number {
    return this.calls.length;
  }

  pending(): PendingCall<T>[] {
    return this.calls.filter((c) => !c.settled);
  }

  lastCall(): PendingCall<T> {
    const call = this.calls[this.calls.length - 1];
    if (call === undefined) throw new Error("no calls recorded");
    return call;
  }
}
