import { compareIdBytes } from "../src/int64.ts";
import {
  type MaybePromise,
  type RangePage,
  type SeekPage,
  type Snapshot,
  SnapshotExpiredError as Expired,
  type SnapshotRemote,
  type SnapshotRequest,
} from "../src/types.ts";

export interface FakeRecord {
  readonly id: string;
  readonly time: bigint;
  readonly content: unknown;
}

export interface RangeQueryContext {
  readonly from: bigint;
  readonly to: bigint;
  readonly token: string;
  readonly index: number;
  readonly total: bigint;
  readonly allRecords: readonly FakeRecord[];
}

export interface SeekQueryContext {
  readonly time: bigint;
  readonly cursor: string | null;
  readonly token: string;
  readonly index: number;
  readonly total: bigint;
  readonly allRecords: readonly FakeRecord[];
}

export interface FakeRemoteOptions {
  readonly k: number;
  /** Snapshot versions returned by successive acquireSnapshot calls. */
  readonly versions?: readonly (readonly FakeRecord[])[];
  readonly rangeHook?: (
    page: RangePage,
    context: RangeQueryContext,
  ) => MaybePromise<RangePage>;
  readonly seekHook?: (
    page: SeekPage,
    context: SeekQueryContext,
  ) => MaybePromise<SeekPage>;
  readonly acquireHook?: (
    range: SnapshotRequest,
    context: { readonly index: number; readonly records: readonly FakeRecord[] },
  ) => MaybePromise<Snapshot | null>;
  readonly seed?: number;
}

interface SnapshotData {
  readonly records: readonly FakeRecord[];
  expired: boolean;
  readonly generation: number;
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace<T>(items: T[], random: () => number): void {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const temporary = items[index];
    items[index] = items[swap];
    items[swap] = temporary;
  }
}

export class FakeRemote implements SnapshotRemote {
  readonly k: number;
  readonly acquireRequests: SnapshotRequest[] = [];
  readonly rangeQueries: Array<{
    readonly from: bigint;
    readonly to: bigint;
    readonly token: string;
  }> = [];
  readonly seekQueries: Array<{
    readonly time: bigint;
    readonly cursor: string | null;
    readonly token: string;
  }> = [];

  private readonly versions: readonly (readonly FakeRecord[])[];
  private readonly snapshots = new Map<string, SnapshotData>();
  private readonly rangeHook:
    | ((page: RangePage, context: RangeQueryContext) => MaybePromise<RangePage>)
    | undefined;
  private readonly seekHook:
    | ((page: SeekPage, context: SeekQueryContext) => MaybePromise<SeekPage>)
    | undefined;
  private readonly acquireHook:
    | ((
        range: SnapshotRequest,
        context: {
          readonly index: number;
          readonly records: readonly FakeRecord[];
        },
      ) => MaybePromise<Snapshot | null>)
    | undefined;
  private readonly random: () => number;
  private versionIndex = -1;
  private tokenCounter = 0;
  private forcedToken: string | null = null;

  constructor(options: FakeRemoteOptions) {
    this.k = options.k;
    this.versions = options.versions ?? [[]];
    this.rangeHook = options.rangeHook;
    this.seekHook = options.seekHook;
    this.acquireHook = options.acquireHook;
    this.random = makeRandom(options.seed ?? 0x51a7);
  }

  acquireSnapshot(range: SnapshotRequest): MaybePromise<Snapshot> {
    this.acquireRequests.push({ from: range.from, to: range.to });
    this.versionIndex += 1;
    const base =
      this.versions[
        Math.min(this.versionIndex, Math.max(this.versions.length - 1, 0))
      ] ?? [];
    if (this.acquireHook !== undefined) {
      const hooked = this.acquireHook(range, {
        index: this.versionIndex,
        records: base,
      });
      if (hooked !== null && typeof hooked === "object" && "then" in hooked) {
        return Promise.resolve(hooked).then((value) =>
          this.finishAcquire(range, base, value),
        );
      }
      return this.finishAcquire(range, base, hooked);
    }
    return this.finishAcquire(range, base, null);
  }

  private finishAcquire(
    _range: SnapshotRequest,
    base: readonly FakeRecord[],
    override: Snapshot | null,
  ): Snapshot {
    this.tokenCounter += 1;
    const token =
      override?.token ?? this.forcedToken ?? `snap-${this.tokenCounter}`;
    this.forcedToken = null;
    this.snapshots.set(token, {
      records: base.slice(),
      expired: false,
      generation: this.tokenCounter,
    });
    return override ?? { token };
  }

  queryRange(
    from: bigint,
    to: bigint,
    snapshotToken: string,
  ): MaybePromise<RangePage> {
    this.rangeQueries.push({ from, to, token: snapshotToken });
    const snapshot = this.requireSnapshot(snapshotToken);
    const matching = snapshot.records.filter(
      (record) => record.time >= from && record.time <= to,
    );
    const total = BigInt(matching.length);
    const sortedDescending = matching.slice().sort((left, right) => {
      if (left.time !== right.time) {
        return left.time > right.time ? -1 : 1;
      }
      return compareIdBytes(left.id, right.id);
    });
    const groups: FakeRecord[][] = [];
    for (const record of sortedDescending) {
      const group = groups[groups.length - 1];
      if (group === undefined || group[0].time !== record.time) {
        groups.push([record]);
      } else {
        group.push(record);
      }
    }
    const shuffled: FakeRecord[] = [];
    for (const group of groups) {
      const copy = group.slice();
      shuffleInPlace(copy, this.random);
      shuffled.push(...copy);
    }
    // The public directory is descending by time, but equal-time order inside
    // a page is deliberately unstable across calls.
    const pageRecords = shuffled.slice(0, this.k);
    const base: RangePage = { total, records: pageRecords };
    if (this.rangeHook !== undefined) {
      return this.rangeHook(base, {
        from,
        to,
        token: snapshotToken,
        index: this.rangeQueries.length - 1,
        total,
        allRecords: matching,
      });
    }
    return base;
  }

  seekById(
    time: bigint,
    afterId: string | null,
    snapshotToken: string,
  ): MaybePromise<SeekPage> {
    this.seekQueries.push({ time, cursor: afterId, token: snapshotToken });
    const snapshot = this.requireSnapshot(snapshotToken);
    const matching = snapshot.records.filter((record) => record.time === time);
    const afterCursor =
      afterId === null
        ? matching.slice()
        : matching.filter((record) => compareIdBytes(record.id, afterId) > 0);
    afterCursor.sort((left, right) => compareIdBytes(left.id, right.id));
    const base: SeekPage = { records: afterCursor.slice(0, this.k) };
    if (this.seekHook !== undefined) {
      return this.seekHook(base, {
        time,
        cursor: afterId,
        token: snapshotToken,
        index: this.seekQueries.length - 1,
        total: BigInt(matching.length),
        allRecords: matching,
      });
    }
    return base;
  }

  expireToken(token: string): void {
    const snapshot = this.snapshots.get(token);
    if (snapshot === undefined) {
      throw new Error(`unknown fake snapshot token: ${token}`);
    }
    snapshot.expired = true;
  }

  expireAll(): void {
    for (const snapshot of this.snapshots.values()) {
      snapshot.expired = true;
    }
  }

  forceNextToken(token: string | null): void {
    this.forcedToken = token;
  }

  pushVersion(records: readonly FakeRecord[]): void {
    (this.versions as Array<readonly FakeRecord[]>).push(records);
  }

  get currentVersionIndex(): number {
    return this.versionIndex;
  }

  private requireSnapshot(token: string): SnapshotData {
    const snapshot = this.snapshots.get(token);
    if (snapshot === undefined || snapshot.expired) {
      throw new Expired(token);
    }
    return snapshot;
  }
}
