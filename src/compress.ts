import type { Op } from './change.js';

/**
 * Net effect of a run of consecutive ops on one key.
 */
type Net =
  | { kind: 'none' }
  | { kind: 'insert'; value: unknown }
  | { kind: 'delete'; oldValue?: unknown }
  | { kind: 'replace'; oldValue?: unknown; value: unknown };

function fold(net: Net, op: Op): Net {
  switch (net.kind) {
    case 'none':
      if (op.kind === 'insert') return { kind: 'insert', value: op.value };
      if (op.kind === 'delete') return { kind: 'delete', oldValue: op.oldValue };
      return { kind: 'replace', oldValue: op.oldValue, value: op.value };
    case 'insert':
      // insert 后 delete：两者抵消，操作消失。
      if (op.kind === 'delete') return { kind: 'none' };
      if (op.kind === 'replace') return { kind: 'insert', value: op.value };
      throw new Error(`invalid sequence: insert then ${op.kind} on same key`);
    case 'delete':
      // delete 后 insert：成为 replace，并保留 delete 记录的原值。
      if (op.kind === 'insert') {
        return { kind: 'replace', oldValue: net.oldValue, value: op.value };
      }
      throw new Error(`invalid sequence: delete then ${op.kind} on same key`);
    case 'replace':
      if (op.kind === 'delete') return { kind: 'delete', oldValue: net.oldValue };
      if (op.kind === 'replace') {
        return { kind: 'replace', oldValue: net.oldValue, value: op.value };
      }
      throw new Error(`invalid sequence: replace then ${op.kind} on same key`);
  }
}

export interface CompressResult {
  /** Compressed batch; never longer than the input. */
  ops: Op[];
  /**
   * Keys whose net effect still needs the original value (delete/replace)
   * but no baseline was recorded. Inversion of these keys requires a
   * baseline lookup first.
   */
  missingBaseline: string[];
}

/**
 * Compress runs of consecutive ops on the same key:
 *  - insert -> delete        : both disappear
 *  - delete -> insert        : becomes replace, keeping the delete's oldValue
 *  - insert -> replace       : becomes insert of the final value
 *  - replace -> replace      : keeps the first oldValue and the final value
 *  - replace -> delete       : becomes delete with the original oldValue
 */
export function compress(ops: readonly Op[]): CompressResult {
  const out: Op[] = [];
  const missing = new Set<string>();
  let runKey: string | null = null;
  let net: Net = { kind: 'none' };

  const flush = (): void => {
    if (runKey !== null && net.kind !== 'none') {
      if (net.kind === 'insert') {
        out.push({ kind: 'insert', key: runKey, value: net.value });
      } else if (net.kind === 'delete') {
        if (net.oldValue === undefined) missing.add(runKey);
        out.push({ kind: 'delete', key: runKey, oldValue: net.oldValue });
      } else {
        if (net.oldValue === undefined) missing.add(runKey);
        out.push({ kind: 'replace', key: runKey, oldValue: net.oldValue, value: net.value });
      }
    }
    runKey = null;
    net = { kind: 'none' };
  };

  for (const op of ops) {
    if (op.key === runKey) {
      net = fold(net, op);
    } else {
      flush();
      runKey = op.key;
      net = fold(net, op);
    }
  }
  flush();
  return { ops: out, missingBaseline: [...missing] };
}
