import { IntegerError } from './errors';

export type State = Record<string, number>;

export function assertSafeInteger(value: number, what: string): void {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new IntegerError(`${what} must be a safe integer, got ${String(value)}`);
  }
}

export function copyState(state: State): State {
  return { ...state };
}
