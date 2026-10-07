import { Buffer } from "node:buffer";

/** A single score mutation. `delta` is a signed integer (negative allowed). */
export interface ScoreEvent {
  readonly id: string;
  readonly user: string;
  readonly delta: number;
}

export interface RankedEntry {
  readonly rank: number; // 1-based, total order (ties broken by UTF-8 username)
  readonly user: string;
  readonly score: number;
}

export interface RankChange {
  readonly user: string;
  readonly before: RankedEntry;
  readonly after: RankedEntry;
}

/** Net change of the TopK window caused by one mutation. */
export interface TopKChange {
  readonly k: number;
  readonly entered: readonly RankedEntry[];
  readonly left: readonly RankedEntry[];
  readonly changed: readonly RankChange[];
}

interface LedgerRecord extends ScoreEvent {
  revoked: boolean;
}

export class LeaderboardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaderboardError";
  }
}

/** Total order on usernames by UTF-8 byte sequence (differs from UTF-16 order for non-BMP chars). */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function validateEvent(event: ScoreEvent): void {
  if (typeof event.id !== "string" || event.id.length === 0) {
    throw new LeaderboardError("event id must be a non-empty string");
  }
  if (typeof event.user !== "string" || event.user.length === 0) {
    throw new LeaderboardError("event user must be a non-empty string");
  }
  if (!Number.isInteger(event.delta)) {
    throw new LeaderboardError(`event delta must be an integer, got: ${event.delta}`);
  }
}

function rankFrom(totals: ReadonlyMap<string, number>): RankedEntry[] {
  return [...totals.entries()]
    .map(([user, score]) => ({ user, score }))
    .sort((x, y) => y.score - x.score || compareUtf8(x.user, y.user))
    .map((entry, index) => ({ rank: index + 1, user: entry.user, score: entry.score }));
}

function diffTopK(k: number, before: readonly RankedEntry[], after: readonly RankedEntry[]): TopKChange {
  const beforeByUser = new Map(before.map((entry) => [entry.user, entry]));
  const afterByUser = new Map(after.map((entry) => [entry.user, entry]));
  const entered = after.filter((entry) => !beforeByUser.has(entry.user));
  const left = before.filter((entry) => !afterByUser.has(entry.user));
  const changed: RankChange[] = [];
  for (const afterEntry of after) {
    const beforeEntry = beforeByUser.get(afterEntry.user);
    if (beforeEntry && (beforeEntry.rank !== afterEntry.rank || beforeEntry.score !== afterEntry.score)) {
      changed.push({ user: afterEntry.user, before: beforeEntry, after: afterEntry });
    }
  }
  return { k, entered, left, changed };
}

/**
 * Leaderboard over integer scores backed by an append-only event ledger.
 *
 * Rules:
 * - Events are uniquely identified by `id`; replaying the same id with the same
 *   content is an idempotent no-op, the same id with different content is rejected.
 * - `revoke(id)` annuls an event exactly once; a revoked event stays in the ledger
 *   but no longer contributes to scores, and cannot be re-applied or re-revoked.
 * - Ranking: higher score first; ties broken by username in UTF-8 byte order.
 * - Every mutation returns the net change of the TopK window.
 */
export class Leaderboard {
  readonly k: number;
  private readonly ledger = new Map<string, LedgerRecord>(); // insertion order preserved
  private readonly totals = new Map<string, number>(); // incremental net scores

  constructor(k: number) {
    if (!Number.isInteger(k) || k <= 0) {
      throw new LeaderboardError(`k must be a positive integer, got: ${k}`);
    }
    this.k = k;
  }

  /** Apply a score event. Returns the TopK net change caused by this event. */
  apply(event: ScoreEvent): TopKChange {
    validateEvent(event);
    const existing = this.ledger.get(event.id);
    if (existing !== undefined) {
      if (existing.user !== event.user || existing.delta !== event.delta) {
        throw new LeaderboardError(`conflicting event id: ${event.id}`);
      }
      if (existing.revoked) {
        throw new LeaderboardError(`event already revoked, cannot re-apply: ${event.id}`);
      }
      return { k: this.k, entered: [], left: [], changed: [] }; // idempotent replay
    }
    const before = this.topK();
    this.ledger.set(event.id, { id: event.id, user: event.user, delta: event.delta, revoked: false });
    this.totals.set(event.user, (this.totals.get(event.user) ?? 0) + event.delta);
    return diffTopK(this.k, before, this.topK());
  }

  /** Revoke an event exactly once. Returns the TopK net change caused by the revocation. */
  revoke(id: string): TopKChange {
    const record = this.ledger.get(id);
    if (record === undefined) {
      throw new LeaderboardError(`unknown event id: ${id}`);
    }
    if (record.revoked) {
      throw new LeaderboardError(`event already revoked: ${id}`);
    }
    const before = this.topK();
    record.revoked = true;
    this.totals.set(record.user, (this.totals.get(record.user) ?? 0) - record.delta);
    return diffTopK(this.k, before, this.topK());
  }

  scoreOf(user: string): number {
    return this.totals.get(user) ?? 0;
  }

  /** Full ranking: score descending, ties by UTF-8 username order. */
  ranking(): RankedEntry[] {
    return rankFrom(this.totals);
  }

  topK(k: number = this.k): RankedEntry[] {
    return this.ranking().slice(0, k);
  }

  /**
   * Recompute all scores from the full ledger (skipping revoked events) and
   * cross-check them against the incrementally maintained totals, including
   * negative and tied scores. Throws LeaderboardError on any mismatch.
   */
  verify(): void {
    const rebuilt = new Map<string, number>();
    for (const record of this.ledger.values()) {
      if (record.revoked) continue;
      rebuilt.set(record.user, (rebuilt.get(record.user) ?? 0) + record.delta);
    }
    const users = new Set<string>([...rebuilt.keys(), ...this.totals.keys()]);
    for (const user of users) {
      const actual = this.totals.get(user) ?? 0;
      const expected = rebuilt.get(user) ?? 0;
      if (!Number.isInteger(actual)) {
        throw new LeaderboardError(`non-integer score for user ${user}: ${actual}`);
      }
      if (actual !== expected) {
        throw new LeaderboardError(
          `ledger mismatch for user ${user}: incremental=${actual}, ledger=${expected}`
        );
      }
    }
  }
}
