/**
 * FixtureStore: a fixture library with immutable baselines, branches (forks)
 * and three-way merges over arbitrary object graphs.
 *
 * Design notes:
 * - Every object in a committed graph gets a stable numeric id (kept in a
 *   WeakMap, so frozen objects work and user data is never mutated).
 * - Forking produces a deep, alias-preserving clone: objects shared in the
 *   baseline stay shared in the branch, cycles stay cycles, and clones keep
 *   the ids of their source objects. Branch writes therefore never touch the
 *   frozen baseline.
 * - Merging is a three-way merge keyed by stable ids: base = the baseline the
 *   branch forked from, ours = the current baseline, theirs = the branch
 *   working copy. Fields changed on exactly one side win; fields changed on
 *   both sides to different values are reported as conflicts. Because nodes
 *   are matched by id (not by position), cycles and aliases survive the merge.
 */

export interface Conflict {
  path: string;
  base: unknown;
  ours: unknown;
  theirs: unknown;
}

export type MergeResult =
  | { ok: true; baseline: unknown }
  | { ok: false; conflicts: Conflict[] };

type AnyObject = Record<string, unknown>;

function isObject(value: unknown): value is AnyObject {
  return typeof value === "object" && value !== null;
}

export class Branch {
  /** Immutable baseline graph as it was when this branch was forked. */
  readonly base: unknown;
  /** Mutable working copy; safe to edit freely. */
  readonly working: unknown;

  constructor(base: unknown, working: unknown) {
    this.base = base;
    this.working = working;
  }
}

export class FixtureStore {
  private baselineGraph: unknown;
  private readonly ids = new WeakMap<object, number>();
  private nextId = 1;

  constructor(root: unknown) {
    this.ensureIds(root);
    this.baselineGraph = this.deepFreeze(this.cloneGraph(root));
  }

  /** The current immutable (deep-frozen) baseline graph. */
  get baseline(): unknown {
    return this.baselineGraph;
  }

  /** Stable id of an object in any graph known to this store. */
  idOf(value: unknown): number | undefined {
    return isObject(value) ? this.ids.get(value) : undefined;
  }

  /** Create a branch: an alias-preserving, cycle-preserving deep clone. */
  fork(): Branch {
    return new Branch(this.baselineGraph, this.cloneGraph(this.baselineGraph));
  }

  /**
   * Three-way merge of a branch back into the baseline. On success the
   * merged graph becomes the new immutable baseline. On conflict the
   * baseline is left untouched and all conflicts are returned.
   */
  merge(branch: Branch): MergeResult {
    const base = branch.base;
    const ours = this.baselineGraph;
    const theirs = branch.working;

    this.ensureIds(base);
    this.ensureIds(ours);
    this.ensureIds(theirs);

    const baseById = this.indexById(base);
    const oursById = this.indexById(ours);
    const theirsById = this.indexById(theirs);

    const memo = new Map<number, AnyObject>();
    const conflicts: Conflict[] = [];

    const fieldEq = (
      a: unknown,
      aPresent: boolean,
      b: unknown,
      bPresent: boolean,
    ): boolean => {
      if (aPresent !== bPresent) return false;
      if (!aPresent) return true;
      const aObj = isObject(a);
      const bObj = isObject(b);
      if (aObj || bObj) {
        return aObj && bObj && this.ids.get(a) === this.ids.get(b);
      }
      return Object.is(a, b);
    };

    const mergeNode = (
      b: unknown,
      o: unknown,
      t: unknown,
      path: string,
    ): AnyObject => {
      const archetype = (isObject(o) ? o : isObject(t) ? t : b) as AnyObject;
      const shell: AnyObject = Array.isArray(archetype) ? ([] as unknown as AnyObject) : {};

      // Seed the memo before recursing so cycles back to this node resolve.
      let chosenId: number | undefined;
      for (const v of [o, t, b]) {
        if (!isObject(v)) continue;
        const id = this.ids.get(v);
        if (id === undefined) continue;
        if (chosenId === undefined) chosenId = id;
        if (!memo.has(id)) memo.set(id, shell);
      }
      if (chosenId !== undefined) this.ids.set(shell, chosenId);

      const keySet = new Set<string>();
      for (const v of [b, o, t]) {
        if (isObject(v)) for (const k of Object.keys(v)) keySet.add(k);
      }
      if (Array.isArray(archetype)) keySet.add("length");
      const keys = [...keySet];
      keys.sort((x, y) => (x === "length" ? 1 : y === "length" ? -1 : 0));

      for (const key of keys) {
        const pb = isObject(b) && Object.prototype.hasOwnProperty.call(b, key);
        const po = isObject(o) && Object.prototype.hasOwnProperty.call(o, key);
        const pt = isObject(t) && Object.prototype.hasOwnProperty.call(t, key);
        const vb = pb ? (b as AnyObject)[key] : undefined;
        const vo = po ? (o as AnyObject)[key] : undefined;
        const vt = pt ? (t as AnyObject)[key] : undefined;

        const changedOurs = !fieldEq(vb, pb, vo, po);
        const changedTheirs = !fieldEq(vb, pb, vt, pt);

        let winValue: unknown;
        let winPresent: boolean;
        if (changedOurs && changedTheirs) {
          if (fieldEq(vo, po, vt, pt)) {
            winValue = vo;
            winPresent = po;
          } else {
            conflicts.push({ path: `${path}.${key}`, base: vb, ours: vo, theirs: vt });
            winValue = vo; // placeholder; result is discarded on conflict
            winPresent = po;
          }
        } else if (changedOurs) {
          winValue = vo;
          winPresent = po;
        } else if (changedTheirs) {
          winValue = vt;
          winPresent = pt;
        } else {
          winValue = vb;
          winPresent = pb;
        }

        if (!winPresent) {
          if (Object.prototype.hasOwnProperty.call(shell, key)) delete shell[key];
          continue;
        }
        if (isObject(winValue)) {
          const id = this.ids.get(winValue)!;
          const existing = memo.get(id);
          if (existing !== undefined) {
            shell[key] = existing;
          } else {
            shell[key] = mergeNode(
              baseById.get(id),
              oursById.get(id),
              theirsById.get(id),
              `${path}.${key}`,
            );
          }
        } else {
          shell[key] = winValue;
        }
      }
      return shell;
    };

    const result = mergeNode(base, ours, theirs, "$");
    if (conflicts.length > 0) return { ok: false, conflicts };

    const frozen = this.deepFreeze(result);
    this.baselineGraph = frozen;
    return { ok: true, baseline: frozen };
  }

  /** Assign stable ids to every object reachable from root. */
  private ensureIds(root: unknown): void {
    const seen = new Set<object>();
    const walk = (v: unknown): void => {
      if (!isObject(v) || seen.has(v)) return;
      seen.add(v);
      if (!this.ids.has(v)) this.ids.set(v, this.nextId++);
      for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(root);
  }

  /** Deep clone preserving aliases and cycles; clones keep source ids. */
  private cloneGraph(root: unknown): unknown {
    const seen = new Map<object, AnyObject>();
    const walk = (v: unknown): unknown => {
      if (!isObject(v)) return v;
      const hit = seen.get(v);
      if (hit !== undefined) return hit;
      const copy: AnyObject = Array.isArray(v) ? ([] as unknown as AnyObject) : {};
      seen.set(v, copy);
      const id = this.ids.get(v);
      if (id !== undefined) this.ids.set(copy, id);
      for (const k of Object.keys(v)) copy[k] = walk(v[k]);
      return copy;
    };
    return walk(root);
  }

  private indexById(root: unknown): Map<number, AnyObject> {
    const map = new Map<number, AnyObject>();
    const seen = new Set<object>();
    const walk = (v: unknown): void => {
      if (!isObject(v) || seen.has(v)) return;
      seen.add(v);
      const id = this.ids.get(v);
      if (id !== undefined && !map.has(id)) map.set(id, v);
      for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(root);
    return map;
  }

  private deepFreeze(root: unknown): unknown {
    const seen = new Set<object>();
    const walk = (v: unknown): void => {
      if (!isObject(v) || seen.has(v)) return;
      seen.add(v);
      for (const k of Object.keys(v)) walk(v[k]);
      Object.freeze(v);
    };
    walk(root);
    return root;
  }
}
