/**
 * Versioned repository on top of the persistent window state.
 *
 * - Every committed state gets an immutable version id; old versions stay
 *   readable forever (the underlying index is persistent).
 * - Branches record value corrections relative to a shared base version.
 * - Merging two branches of the same base applies all one-sided (or
 *   identical) corrections directly; the same event corrected to two
 *   different values becomes a conflict.
 * - While conflicts are open, queries return the certain part plus
 *   uncertain rank bounds (lower/upper over both sides' choices).
 * - Resolution builds the fully-resolved state first and then publishes it
 *   as one new version in a single atomic step; existing versions and the
 *   conflicted view are unaffected.
 */
import { countLess, insert, select, sizeOf, toArray, Node } from './treap.js';
import { quantileRank } from './quantile.js';
import {
  WindowState,
  addEvent,
  correctEvent,
  createWindow,
  quantile,
  removeEvent,
} from './window.js';

export interface Conflict {
  readonly eventId: number;
  /** Value the event had in the shared base version. */
  readonly base: number;
  readonly left: number;
  readonly right: number;
}

export interface QuantileBounds {
  /** Total window size, including one slot per open conflict. */
  readonly n: number;
  /** Target rank ceil(p*n), clamped to >= 1. */
  readonly rank: number;
  /** Smallest value that can sit at `rank` over all conflict resolutions. */
  readonly lower: number;
  /** Largest value that can sit at `rank` over all conflict resolutions. */
  readonly upper: number;
  /** True when lower === upper, i.e. this rank is already determined. */
  readonly certain: boolean;
}

export interface RankBounds {
  readonly value: number;
  /** Smallest possible 1-based rank of the first occurrence of `value`. */
  readonly lower: number;
  /** Largest possible 1-based rank of the first occurrence of `value`. */
  readonly upper: number;
  readonly certain: boolean;
}

interface Branch {
  readonly base: number;
  /** eventId -> corrected value, in application order. */
  readonly corrections: Map<number, number>;
}

export class Repo {
  private readonly versions = new Map<number, WindowState>();
  private readonly branches = new Map<string, Branch>();
  private nextVersionId = 1;

  /** Number of published versions (monotonically grows; used by tests). */
  get versionCount(): number {
    return this.versions.size;
  }

  /** Atomically publish a fully-built state as a new version. */
  publish(state: WindowState): number {
    const id = this.nextVersionId++;
    this.versions.set(id, state);
    return id;
  }

  createWindow(capacity: number): number {
    return this.publish(createWindow(capacity));
  }

  /** Read an immutable snapshot of a published version. */
  snapshot(versionId: number): WindowState {
    const state = this.versions.get(versionId);
    if (state === undefined) throw new RangeError(`unknown version ${versionId}`);
    return state;
  }

  /** Apply an op to a version and publish the result as a new version. */
  apply(versionId: number, op: (state: WindowState) => WindowState): number {
    const before = this.snapshot(versionId);
    const after = op(before);
    return after === before ? versionId : this.publish(after);
  }

  addEvent(versionId: number, eventId: number, value: number): number {
    return this.apply(versionId, (s) => addEvent(s, eventId, value));
  }

  removeEvent(versionId: number, eventId: number): number {
    return this.apply(versionId, (s) => removeEvent(s, eventId));
  }

  correctEvent(versionId: number, eventId: number, value: number): number {
    return this.apply(versionId, (s) => correctEvent(s, eventId, value));
  }

  quantileAt(versionId: number, pNum: number, pDen: number): number | null {
    return quantile(this.snapshot(versionId), pNum, pDen);
  }

  /** Fork a correction branch at a base version. */
  fork(name: string, baseVersion: number): void {
    if (this.branches.has(name)) throw new Error(`branch ${name} already exists`);
    this.snapshot(baseVersion); // validate
    this.branches.set(name, { base: baseVersion, corrections: new Map() });
  }

  /** Record a value correction for an event on a branch. */
  correctOnBranch(name: string, eventId: number, value: number): void {
    const branch = this.branch(name);
    const baseValue = this.snapshot(branch.base).values.get(eventId);
    if (baseValue === undefined) {
      throw new Error(`event ${eventId} is not in the base window`);
    }
    const effective = branch.corrections.get(eventId) ?? baseValue;
    if (effective === value) return; // no-op correction
    branch.corrections.set(eventId, value);
  }

  /** Effective window of a branch: base version plus its corrections. */
  branchState(name: string): WindowState {
    const branch = this.branch(name);
    let state = this.snapshot(branch.base);
    for (const [eventId, value] of branch.corrections) {
      state = correctEvent(state, eventId, value);
    }
    return state;
  }

  /** Merge two branches forked from the same base version. */
  merge(leftName: string, rightName: string): MergedState {
    const left = this.branch(leftName);
    const right = this.branch(rightName);
    if (left.base !== right.base) {
      throw new Error('cannot merge branches forked from different base versions');
    }
    const baseState = this.snapshot(left.base);
    const agreed = new Map<number, number>();
    const conflicts: Conflict[] = [];
    const ids = new Set<number>([...left.corrections.keys(), ...right.corrections.keys()]);
    for (const eventId of [...ids].sort((a, b) => a - b)) {
      const hasLeft = left.corrections.has(eventId);
      const hasRight = right.corrections.has(eventId);
      const leftValue = left.corrections.get(eventId);
      const rightValue = right.corrections.get(eventId);
      if (hasLeft && hasRight && leftValue !== rightValue) {
        conflicts.push({
          eventId,
          base: baseState.values.get(eventId)!,
          left: leftValue!,
          right: rightValue!,
        });
      } else {
        agreed.set(eventId, (hasLeft ? leftValue : rightValue)!);
      }
    }
    return new MergedState(this, left.base, agreed, conflicts);
  }

  private branch(name: string): Branch {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new Error(`unknown branch ${name}`);
    return branch;
  }
}

/** Result of merging two branches: agreed corrections plus open conflicts. */
export class MergedState {
  readonly conflicts: readonly Conflict[];

  private certainCache: WindowState | undefined;

  constructor(
    private readonly repo: Repo,
    readonly baseVersion: number,
    /** eventId -> value for corrections both sides agree on (or only one made). */
    readonly agreed: ReadonlyMap<number, number>,
    conflicts: readonly Conflict[],
  ) {
    this.conflicts = conflicts;
  }

  /**
   * Window with all agreed corrections applied and every conflicting event
   * removed; this is the certain part shared by all resolutions.
   */
  certainState(): WindowState {
    if (this.certainCache === undefined) {
      let state = this.repo.snapshot(this.baseVersion);
      for (const [eventId, value] of this.agreed) {
        state = correctEvent(state, eventId, value);
      }
      for (const conflict of this.conflicts) {
        state = removeEvent(state, conflict.eventId);
      }
      this.certainCache = state;
    }
    return this.certainCache;
  }

  /** Sorted certain values (everything except the open conflicts). */
  certainValues(): number[] {
    return toArray(this.certainState().root);
  }

  size(): number {
    return sizeOf(this.certainState().root) + this.conflicts.length;
  }

  /**
   * Quantile with open conflicts: the value at rank ceil(p*n) is bounded by
   * resolving every conflict to its smaller option (lower bound) or its
   * larger option (upper bound). The all-min choice multiset is
   * componentwise <= any other choice multiset in sorted order, and the
   * all-max choice multiset is componentwise >=, so these give exact bounds.
   */
  quantileBounds(pNum: number, pDen: number): QuantileBounds | null {
    const n = this.size();
    if (n === 0) return null;
    const rank = quantileRank(pNum, pDen, n);
    let lowRoot: Node | undefined = this.certainState().root;
    let highRoot: Node | undefined = lowRoot;
    for (const conflict of this.conflicts) {
      lowRoot = insert(lowRoot, Math.min(conflict.left, conflict.right));
      highRoot = insert(highRoot, Math.max(conflict.left, conflict.right));
    }
    const lower = select(lowRoot!, rank);
    const upper = select(highRoot!, rank);
    return { n, rank, lower, upper, certain: lower === upper };
  }

  /**
   * Bounds on the 1-based rank of the first occurrence of `value`:
   * a conflict certainly sits below `value` only when both options do,
   * and can sit below `value` when at least one option does.
   */
  rankBounds(value: number): RankBounds {
    const base = countLess(this.certainState().root, value) + 1;
    let minExtra = 0;
    let maxExtra = 0;
    for (const conflict of this.conflicts) {
      if (Math.max(conflict.left, conflict.right) < value) minExtra++;
      if (Math.min(conflict.left, conflict.right) < value) maxExtra++;
    }
    const lower = base + minExtra;
    const upper = base + maxExtra;
    return { value, lower, upper, certain: lower === upper };
  }

  /**
   * Resolve every conflict by picking the 'left' or 'right' correction per
   * event, then atomically publish the fully-resolved window as a new
   * version. Old versions and this conflicted view stay readable.
   */
  resolve(choices: ReadonlyMap<number, 'left' | 'right'> = new Map()): number {
    let state = this.repo.snapshot(this.baseVersion);
    for (const [eventId, value] of this.agreed) {
      state = correctEvent(state, eventId, value);
    }
    for (const conflict of this.conflicts) {
      const choice = choices.get(conflict.eventId);
      if (choice === undefined) {
        throw new Error(`missing resolution for conflicting event ${conflict.eventId}`);
      }
      state = correctEvent(state, conflict.eventId, choice === 'left' ? conflict.left : conflict.right);
    }
    // Single atomic publish: the new version becomes visible only fully built.
    return this.repo.publish(state);
  }
}
