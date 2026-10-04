import type { Migration } from './types.js';

interface PathState {
  version: string;
  ids: string[];
  path: Migration[];
}

function compareIds(a: string[], b: string[]): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

export class VersionGraph {
  private readonly migrations: Migration[] = [];

  add(migration: Migration): void {
    this.migrations.push(migration);
  }

  getById(id: string): Migration | null {
    for (const m of this.migrations) {
      if (m.id === id) return m;
    }
    return null;
  }

  private outgoing(version: string): Migration[] {
    const result: Migration[] = [];
    for (const m of this.migrations) {
      if (m.from === version) result.push(m);
    }
    result.sort((a, b) => {
      if (a.id < b.id) return -1;
      if (a.id > b.id) return 1;
      return 0;
    });
    return result;
  }

  // Path selection: fewest steps first; ties broken by the lexicographically
  // smallest migration-id sequence. Dijkstra over the cost tuple
  // (stepCount, idSequence), which is monotonic along every path.
  findPath(from: string, to: string): Migration[] | null {
    if (from === to) return [];
    const best: Map<string, string[]> = new Map();
    const queue: PathState[] = [{ version: from, ids: [], path: [] }];
    best.set(from, []);
    while (queue.length > 0) {
      let minIdx = 0;
      for (let i = 1; i < queue.length; i++) {
        const a = queue[i];
        const b = queue[minIdx];
        if (a.ids.length !== b.ids.length) {
          if (a.ids.length < b.ids.length) minIdx = i;
        } else if (compareIds(a.ids, b.ids) < 0) {
          minIdx = i;
        }
      }
      const state = queue.splice(minIdx, 1)[0];
      if (state.version === to) return state.path;
      const known = best.get(state.version);
      if (known !== undefined && (known.length < state.ids.length ||
          (known.length === state.ids.length && compareIds(known, state.ids) < 0))) {
        continue;
      }
      for (const m of this.outgoing(state.version)) {
        const nextIds = state.ids.concat([m.id]);
        const seen = best.get(m.to);
        if (seen !== undefined && (seen.length < nextIds.length ||
            (seen.length === nextIds.length && compareIds(seen, nextIds) <= 0))) {
          continue;
        }
        best.set(m.to, nextIds);
        queue.push({ version: m.to, ids: nextIds, path: state.path.concat([m]) });
      }
    }
    return null;
  }
}
