import { State } from './util';

export interface CaptureResult {
  ok: boolean;
  error?: unknown;
}

export interface TxMachine {
  begin(): void;
  commit(): void;
  rollback(): void;
  capture(fn: () => void): CaptureResult;
  set(name: string, value: number): void;
  add(name: string, delta: number): void;
  mul(name: string, factor: number): void;
  stage(action: string): void;
  get(name: string): number;
  snapshot(): State;
  readonly depth: number;
  readonly published: readonly string[];
  readonly budgetLeft: number | null;
  drainPublished(): string[];
  run<T>(fn: () => T, options?: { budget?: number | null }): T;
}
