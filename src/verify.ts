import { runQuery, type OutputRow, type Query } from './engine.js';
import { runAuthorizeThenQuery } from './model.js';
import type { PolicySnapshot } from './policy.js';
import type { Table } from './table.js';

export interface Verification {
  readonly ok: boolean;
  readonly engine: readonly OutputRow[];
  readonly model: readonly OutputRow[];
  readonly mismatches: readonly string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && Number.isNaN(value)) return '"#NaN"';
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(',')}}`;
}

export function verifyAgainstModel(table: Table, snapshot: PolicySnapshot, query: Query = {}): Verification {
  const engine = runQuery(table, snapshot, query);
  const model = runAuthorizeThenQuery(table, snapshot, query);
  const mismatches: string[] = [];
  if (engine.length !== model.length) {
    mismatches.push(`row count differs: engine=${engine.length} model=${model.length}`);
  }
  const n = Math.min(engine.length, model.length);
  for (let i = 0; i < n; i++) {
    const a = canonical(engine[i]);
    const b = canonical(model[i]);
    if (a !== b) {
      mismatches.push(`row ${i} differs:\n  engine: ${a}\n  model:  ${b}`);
    }
  }
  return { ok: mismatches.length === 0, engine, model, mismatches };
}
