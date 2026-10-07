import type { Migration } from "./types";

/**
 * Find a migration path through the version graph.
 *
 * Ordering: fewest steps first; ties are broken by comparing the migration
 * id sequences element by element (lexicographic), so the winner is
 * deterministic regardless of registration order.
 *
 * Throws when no path exists.
 */
export function findPath(
  migrations: Migration[],
  from: string,
  to: string,
): Migration[] {
  if (from === to) return [];

  const byFrom = new Map<string, Migration[]>();
  for (const migration of migrations) {
    const edges = byFrom.get(migration.from);
    if (edges) edges.push(migration);
    else byFrom.set(migration.from, [migration]);
  }

  interface State {
    version: string;
    path: Migration[];
    key: string; // NUL-joined id sequence, safe for lexicographic compare
  }

  const better = (aSteps: number, aKey: string, bSteps: number, bKey: string) =>
    aSteps < bSteps || (aSteps === bSteps && aKey < bKey);

  const best = new Map<string, { steps: number; key: string }>();
  best.set(from, { steps: 0, key: "" });
  const queue: State[] = [{ version: from, path: [], key: "" }];

  let result: Migration[] | null = null;
  let resultKey = "";

  while (queue.length > 0) {
    let head = 0;
    for (let i = 1; i < queue.length; i++) {
      const candidate = queue[i]!;
      const current = queue[head]!;
      if (better(candidate.path.length, candidate.key, current.path.length, current.key)) {
        head = i;
      }
    }
    const state = queue.splice(head, 1)[0]!;

    if (result && !better(state.path.length, state.key, result.length, resultKey)) {
      continue;
    }
    if (state.version === to) {
      result = state.path;
      resultKey = state.key;
      continue;
    }
    for (const edge of byFrom.get(state.version) ?? []) {
      const steps = state.path.length + 1;
      const key = state.key + "" + edge.id;
      const known = best.get(edge.to);
      if (known && !better(steps, key, known.steps, known.key)) continue;
      best.set(edge.to, { steps, key });
      queue.push({ version: edge.to, path: [...state.path, edge], key });
    }
  }

  if (!result) {
    throw new Error(`no migration path from version "${from}" to "${to}"`);
  }
  return result;
}
