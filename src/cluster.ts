import { Replica } from "./replica";
import {
  mergeSets,
  visibleState,
  type VersionedValue,
  type VisibleState,
} from "./versionedValue";

export interface WriteResult {
  item: VersionedValue;
  acked: string[];
}

export interface RepairEvent {
  replica: string;
  added: VersionedValue[];
  pruned: VersionedValue[];
}

export interface ReadResult {
  key: string;
  sources: string[];
  merged: VersionedValue[];
  state: VisibleState;
  repairs: RepairEvent[];
}

export interface TransferEvent {
  from: string;
  to: string;
  key: string;
  added: number;
  pruned: number;
}

export class Cluster {
  readonly replicas: Replica[];
  private links: boolean[][];

  constructor(ids: string[]) {
    this.replicas = ids.map((id) => new Replica(id));
    this.links = ids.map(() => ids.map(() => true));
  }

  heal(): void {
    this.links = this.replicas.map(() => this.replicas.map(() => true));
  }

  partition(groups: number[][]): void {
    const n = this.replicas.length;
    const next: boolean[][] = Array.from({ length: n }, () =>
      new Array<boolean>(n).fill(false),
    );
    for (const group of groups) {
      for (const i of group) {
        for (const j of group) {
          next[i][j] = true;
          next[j][i] = true;
        }
      }
    }
    for (let i = 0; i < n; i++) next[i][i] = true;
    this.links = next;
  }

  reachableFrom(index: number): number[] {
    return this.replicas
      .map((_, j) => j)
      .filter((j) => this.links[index][j]);
  }

  private replica(index: number): Replica {
    const found = this.replicas[index];
    if (!found) throw new Error(`副本 #${index} 不存在`);
    return found;
  }

  write(key: string, value: number, coordinator: number, w: number): WriteResult {
    const coord = this.replica(coordinator);
    const item = coord.localWrite(key, value);
    const acked = [coord.id];
    for (const j of this.reachableFrom(coordinator)) {
      if (acked.length >= w) break;
      if (j === coordinator) continue;
      this.replica(j).applyRemote(key, [item]);
      acked.push(this.replica(j).id);
    }
    return { item, acked };
  }

  delete(key: string, coordinator: number, w: number): WriteResult {
    const coord = this.replica(coordinator);
    const item = coord.localDelete(key);
    const acked = [coord.id];
    for (const j of this.reachableFrom(coordinator)) {
      if (acked.length >= w) break;
      if (j === coordinator) continue;
      this.replica(j).applyRemote(key, [item]);
      acked.push(this.replica(j).id);
    }
    return { item, acked };
  }

  read(key: string, from: number[]): ReadResult {
    const sources = [...new Set(from)];
    if (sources.length < 2) {
      throw new Error("读路径至少需要两个副本 (r >= 2)");
    }
    const head = sources[0];
    for (const j of sources) {
      if (!this.links[head][j]) {
        throw new Error(`副本 #${j} 对协调者 #${head} 不可达`);
      }
    }
    let merged: VersionedValue[] = [];
    for (const j of sources) {
      merged = mergeSets(merged, this.replica(j).getSet(key));
    }
    const repairs: RepairEvent[] = [];
    for (const j of sources) {
      const result = this.replica(j).applyRemote(key, merged);
      if (result.added.length > 0 || result.pruned.length > 0) {
        repairs.push({ replica: this.replica(j).id, ...result });
      }
    }
    return {
      key,
      sources: sources.map((j) => this.replica(j).id),
      merged,
      state: visibleState(merged),
      repairs,
    };
  }

  syncAll(): TransferEvent[] {
    const events: TransferEvent[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (let i = 0; i < this.replicas.length; i++) {
        for (const j of this.reachableFrom(i)) {
          if (i === j) continue;
          const keys = new Set([
            ...this.replica(i).keys(),
            ...this.replica(j).keys(),
          ]);
          for (const key of keys) {
            const result = this.replica(j).applyRemote(
              key,
              this.replica(i).getSet(key),
            );
            if (result.added.length > 0 || result.pruned.length > 0) {
              events.push({
                from: this.replica(i).id,
                to: this.replica(j).id,
                key,
                added: result.added.length,
                pruned: result.pruned.length,
              });
              changed = true;
            }
          }
        }
      }
    }
    return events;
  }
}
