/**
 * Full version model + barrier-history reconciler.
 *
 * The model is an independent, naive reference implementation: it keeps
 * EVERY committed version ever produced (replayed from the recorded
 * history) and answers "what was visible at snapshot T?" directly.
 *
 * reconcileBarrierHistory() replays the engine's recorded history event by
 * event and checks, for a snapshot-isolation implementation:
 *
 *  1. Every read returns the value of the full version model at the
 *     transaction's snapshotTs, overlaid with the transaction's own
 *     staged writes (read-your-own-writes).
 *  2. Every successful commit has NO write-set key with a version
 *     committed after its snapshot (write-set-only validation).
 *  3. Every conflict abort is justified: the recorded evidence points at
 *     a real version with snapshotTs < conflictingCommitTs.
 *  4. Commit timestamps are strictly increasing and respect barriers:
 *     commits in a later epoch (after a barrier) carry larger commitTs
 *     than every commit in earlier epochs.
 *  5. Finally the model's complete version chains are compared against
 *     the engine's actual version chains (full version model check).
 */

import type { Cell, HistoryEvent, Key, Version } from './mvcc.js';

interface WriteRef {
  table: string;
  key: Key;
  value: Cell;
}

export class FullVersionModel {
  private versions = new Map<string, Map<Key, Version[]>>();

  applyCommit(commitTs: number, writeSet: WriteRef[]): void {
    for (const w of writeSet) {
      let rows = this.versions.get(w.table);
      if (!rows) {
        rows = new Map();
        this.versions.set(w.table, rows);
      }
      let chain = rows.get(w.key);
      if (!chain) {
        chain = [];
        rows.set(w.key, chain);
      }
      chain.push({ commitTs, value: w.value });
    }
  }

  latestCommitTs(table: string, key: Key): number | undefined {
    const chain = this.versions.get(table)?.get(key);
    return chain && chain.length > 0 ? chain[chain.length - 1].commitTs : undefined;
  }

  hasVersion(table: string, key: Key, commitTs: number): boolean {
    return (this.versions.get(table)?.get(key) ?? []).some((v) => v.commitTs === commitTs);
  }

  /** Value visible at `snapshotTs`; undefined = absent, tombstones collapse to absent. */
  visibleAt(snapshotTs: number, table: string, key: Key): Cell | undefined {
    const chain = this.versions.get(table)?.get(key);
    if (!chain) return undefined;
    let best: Version | undefined;
    for (const v of chain) {
      if (v.commitTs <= snapshotTs) best = v;
      else break;
    }
    if (!best || best.value === null) return undefined;
    return best.value;
  }

  chains(): Map<string, Map<Key, Version[]>> {
    const out = new Map<string, Map<Key, Version[]>>();
    for (const [t, rows] of this.versions) {
      const copy = new Map<Key, Version[]>();
      for (const [k, chain] of rows) copy.set(k, chain.map((v) => ({ ...v })));
      out.set(t, copy);
    }
    return out;
  }
}

function chainsEqual(
  a: Map<string, Map<Key, Version[]>>,
  b: Map<string, Map<Key, Version[]>>,
): string | undefined {
  const tables = new Set([...a.keys(), ...b.keys()]);
  for (const t of tables) {
    const ra = a.get(t);
    const rb = b.get(t);
    if (!ra || !rb) return `table ${t}: presence mismatch (model=${!!ra}, engine=${!!rb})`;
    const keys = new Set([...ra.keys(), ...rb.keys()]);
    for (const k of keys) {
      const ca = ra.get(k) ?? [];
      const cb = rb.get(k) ?? [];
      if (ca.length !== cb.length) {
        return `table ${t} key ${k}: chain length model=${ca.length} engine=${cb.length}`;
      }
      for (let i = 0; i < ca.length; i++) {
        if (ca[i].commitTs !== cb[i].commitTs || ca[i].value !== cb[i].value) {
          return (
            `table ${t} key ${k} version #${i}: ` +
            `model={ts:${ca[i].commitTs},v:${String(ca[i].value)}} ` +
            `engine={ts:${cb[i].commitTs},v:${String(cb[i].value)}}`
          );
        }
      }
    }
  }
  return undefined;
}

interface TxnState {
  snapshotTs: number;
  epoch: number;
  staged: Map<string, Cell>;
}

const stagedKey = (table: string, key: Key): string => `${table}${key}`;

/**
 * Replays `history` against a fresh FullVersionModel and returns the list
 * of violations (empty = history is a legal SI barrier history whose
 * version chains match the full version model exactly).
 */
export function reconcileBarrierHistory(
  history: HistoryEvent[],
  engineChains: Map<string, Map<Key, Version[]>>,
): string[] {
  const violations: string[] = [];
  const model = new FullVersionModel();
  const txns = new Map<number, TxnState>();
  let epoch = 0;
  let lastCommitTs = 0;
  const epochMaxCommitTs = new Map<number, number>();

  for (const ev of history) {
    switch (ev.kind) {
      case 'barrier': {
        epoch = ev.epoch;
        break;
      }
      case 'begin': {
        txns.set(ev.txnId, { snapshotTs: ev.snapshotTs, epoch: ev.epoch, staged: new Map() });
        if (ev.snapshotTs !== lastCommitTs) {
          violations.push(
            `txn ${ev.txnId}: snapshotTs ${ev.snapshotTs} != lastCommitTs ${lastCommitTs} at begin`,
          );
        }
        break;
      }
      case 'write': {
        const txn = txns.get(ev.txnId);
        if (!txn) {
          violations.push(`write by unknown txn ${ev.txnId}`);
          break;
        }
        txn.staged.set(stagedKey(ev.table, ev.key), ev.value);
        break;
      }
      case 'read': {
        const txn = txns.get(ev.txnId);
        if (!txn) {
          violations.push(`read by unknown txn ${ev.txnId}`);
          break;
        }
        const own = txn.staged.get(stagedKey(ev.table, ev.key));
        const expected =
          own !== undefined
            ? own === null
              ? undefined
              : own
            : model.visibleAt(txn.snapshotTs, ev.table, ev.key);
        if (expected !== ev.value) {
          violations.push(
            `txn ${ev.txnId} read ${ev.table}(${ev.key}): got ${String(ev.value)}, ` +
              `model at snapshot ${txn.snapshotTs} says ${String(expected)}`,
          );
        }
        break;
      }
      case 'commit': {
        const txn = txns.get(ev.txnId);
        if (!txn) {
          violations.push(`commit by unknown txn ${ev.txnId}`);
          break;
        }
        // (2) write-set-only validation: no written key may have a newer committed version.
        for (const w of ev.writeSet) {
          const latest = model.latestCommitTs(w.table, w.key);
          if (latest !== undefined && latest > txn.snapshotTs) {
            violations.push(
              `txn ${ev.txnId} committed despite newer version on ${w.table}(${w.key}): ` +
                `snapshot=${txn.snapshotTs} < committed=${latest}`,
            );
          }
        }
        // (4) strictly increasing commitTs, monotone across barrier epochs.
        if (ev.commitTs <= lastCommitTs) {
          violations.push(`txn ${ev.txnId}: commitTs ${ev.commitTs} not > previous ${lastCommitTs}`);
        }
        for (const [e, maxTs] of epochMaxCommitTs) {
          if (e < txn.epoch && ev.commitTs <= maxTs) {
            violations.push(
              `txn ${ev.txnId}: commitTs ${ev.commitTs} in epoch ${txn.epoch} ` +
                `not after barrier (epoch ${e} reached commitTs ${maxTs})`,
            );
          }
        }
        epochMaxCommitTs.set(txn.epoch, Math.max(epochMaxCommitTs.get(txn.epoch) ?? 0, ev.commitTs));
        lastCommitTs = ev.commitTs;
        model.applyCommit(ev.commitTs, ev.writeSet);
        txns.delete(ev.txnId);
        break;
      }
      case 'abort': {
        const txn = txns.get(ev.txnId);
        if (!txn) {
          violations.push(`abort by unknown txn ${ev.txnId}`);
          break;
        }
        if (ev.reason === 'conflict') {
          // (3) every piece of evidence must be a real, newer committed version.
          if (ev.conflicts.length === 0) {
            violations.push(`txn ${ev.txnId}: conflict abort without evidence`);
          }
          for (const c of ev.conflicts) {
            if (!(c.conflictingCommitTs > c.snapshotTs)) {
              violations.push(
                `txn ${ev.txnId}: bogus evidence ${c.table}(${c.key}) ` +
                  `snapshot=${c.snapshotTs} conflicting=${c.conflictingCommitTs}`,
              );
            }
            if (c.snapshotTs !== txn.snapshotTs) {
              violations.push(`txn ${ev.txnId}: evidence snapshotTs mismatch`);
            }
            if (!model.hasVersion(c.table, c.key, c.conflictingCommitTs)) {
              violations.push(
                `txn ${ev.txnId}: evidence version ${c.table}(${c.key})@${c.conflictingCommitTs} ` +
                  `not present in full version model`,
              );
            }
            if (!txn.staged.has(stagedKey(c.table, c.key))) {
              violations.push(
                `txn ${ev.txnId}: conflict on ${c.table}(${c.key}) which is not in its write-set`,
              );
            }
          }
        }
        txns.delete(ev.txnId);
        break;
      }
    }
  }

  // (5) full version model vs engine version chains.
  const diff = chainsEqual(model.chains(), engineChains);
  if (diff) violations.push(`version-chain mismatch: ${diff}`);

  return violations;
}
