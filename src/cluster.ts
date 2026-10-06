import { VersionVector } from './version-vector.js';
import { Replica } from './replica.js';
import {
  DominanceEvidence,
  VersionedValue,
  contextOf,
  mergeSiblings,
  sameSet,
} from './siblings.js';

export interface RepairRecord {
  readonly replica: string;
  readonly installed: readonly string[];
}

export interface ReadOutcome<T = unknown> {
  readonly key: string;
  readonly siblings: readonly VersionedValue<T>[];
  readonly context: VersionVector;
  readonly contacted: readonly string[];
  readonly evidence: readonly DominanceEvidence[];
  readonly repairs: readonly RepairRecord[];
}

/**
 * A cluster of replicas with an explicit point-to-point link matrix, so
 * network partitions can be simulated by cutting links between groups.
 */
export class Cluster<T = unknown> {
  readonly replicas: Replica<T>[];
  private links: boolean[][];

  constructor(replicaIds: readonly string[]) {
    this.replicas = replicaIds.map((id) => new Replica<T>(id));
    this.links = replicaIds.map(() => replicaIds.map(() => true));
    this.heal();
  }

  private indexOf(id: string): number {
    const i = this.replicas.findIndex((r) => r.id === id);
    if (i < 0) throw new Error(`unknown replica ${id}`);
    return i;
  }

  /** Full mesh: every replica can exchange with every other. */
  heal(): void {
    this.links = this.replicas.map((_, i) =>
      this.replicas.map((__, j) => i !== j),
    );
  }

  /** Only replicas inside the same group can communicate. */
  partition(groups: readonly (readonly string[])[]): void {
    const n = this.replicas.length;
    this.links = this.replicas.map(() => this.replicas.map(() => false));
    for (const group of groups) {
      for (const a of group) {
        for (const b of group) {
          if (a !== b) this.links[this.indexOf(a)]![this.indexOf(b)] = true;
        }
      }
    }
    if (n === 0) throw new Error('empty cluster');
  }

  reachableFrom(id: string): Replica<T>[] {
    const from = this.indexOf(id);
    return this.replicas.filter((_, j) => j === from || this.links[from]![j]!);
  }

  write(
    at: string,
    key: string,
    value: T,
    context: VersionVector = VersionVector.zero(),
    evidence?: DominanceEvidence[],
  ): VersionedValue<T> {
    return this.replicas[this.indexOf(at)]!.write(key, value, context, evidence);
  }

  /**
   * Coordinated read: contact at least `minReplicas` reachable replicas
   * (default 2), set-merge their conflict sets, then read-repair every
   * contacted replica that is missing versions.
   */
  read(coordinator: string, key: string, minReplicas = 2): ReadOutcome<T> {
    const contacted = this.reachableFrom(coordinator);
    if (contacted.length < minReplicas) {
      throw new Error(
        `read of "${key}" needs >= ${minReplicas} replicas, only ${contacted.length} reachable from ${coordinator}`,
      );
    }
    const evidence: DominanceEvidence[] = [];
    const merged = mergeSiblings(
      contacted.flatMap((r) => r.readLocal(key)),
      evidence,
    );

    const repairs: RepairRecord[] = [];
    for (const replica of contacted) {
      const local = replica.readLocal(key);
      if (!sameSet(local, merged)) {
        const localKeys = new Set(local.map((s) => s.vv.toString()));
        replica.accept(key, merged);
        repairs.push({
          replica: replica.id,
          installed: merged
            .map((s) => s.vv.toString())
            .filter((k) => !localKeys.has(k)),
        });
      }
    }

    return {
      key,
      siblings: merged,
      context: contextOf(merged),
      contacted: contacted.map((r) => r.id),
      evidence,
      repairs,
    };
  }

  /** Anti-entropy: every connected pair exchanges and set-merges all keys. */
  syncRound(evidence?: DominanceEvidence[]): number {
    let exchanges = 0;
    for (let i = 0; i < this.replicas.length; i++) {
      for (let j = i + 1; j < this.replicas.length; j++) {
        if (!this.links[i]![j]!) continue;
        const a = this.replicas[i]!;
        const b = this.replicas[j]!;
        const keys = new Set([...a.keys(), ...b.keys()]);
        for (const key of keys) {
          const union = [...a.readLocal(key), ...b.readLocal(key)];
          a.accept(key, union, evidence);
          b.accept(key, union, evidence);
        }
        exchanges++;
      }
    }
    return exchanges;
  }

  /** Sync until no replica changes (bounded by replica count). */
  syncToFixpoint(evidence?: DominanceEvidence[]): void {
    for (let round = 0; round <= this.replicas.length; round++) {
      const before = this.snapshot();
      this.syncRound(evidence);
      const after = this.snapshot();
      if (before === after) return;
    }
  }

  /** Canonical snapshot of every replica's conflict sets, for comparisons. */
  snapshot(): string {
    return this.replicas
      .map((r) => {
        const keys = r.keys().sort();
        const body = keys
          .map(
            (k) =>
              `${k}=[${r
                .readLocal(k)
                .map((s) => s.vv.toString())
                .sort()
                .join(' | ')}]`,
          )
          .join(', ');
        return `${r.id}:{${body}}`;
      })
      .join('\n');
  }
}
