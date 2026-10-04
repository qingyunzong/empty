/**
 * Change operations on a key-value document.
 *
 * `oldValue` records the value before the operation (the baseline).
 * `oldValue === undefined` means the original value is UNKNOWN; any
 * inversion that needs it must report that a baseline is required.
 */
export type Op =
  | { kind: 'insert'; key: string; value: unknown }
  | { kind: 'delete'; key: string; oldValue?: unknown }
  | { kind: 'replace'; key: string; oldValue?: unknown; value: unknown };

export type State = Map<string, unknown>;

export function applyOp(state: State, op: Op): void {
  switch (op.kind) {
    case 'insert':
      if (state.has(op.key)) throw new Error(`insert on existing key: ${op.key}`);
      state.set(op.key, op.value);
      return;
    case 'delete':
      if (!state.has(op.key)) throw new Error(`delete on missing key: ${op.key}`);
      state.delete(op.key);
      return;
    case 'replace':
      if (!state.has(op.key)) throw new Error(`replace on missing key: ${op.key}`);
      state.set(op.key, op.value);
      return;
  }
}

/** Apply a batch to a copy of `state`; the input is not mutated. */
export function applyOps(state: State, ops: readonly Op[]): State {
  const next: State = new Map(state);
  for (const op of ops) applyOp(next, op);
  return next;
}
