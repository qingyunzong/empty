/**
 * Leaderboard: integer user scores driven by an append-only event ledger
 * with single-shot revocation.
 *
 * Rules:
 * - Every event has a unique string id. Re-applying the same id with the
 *   same content is an idempotent no-op; the same id with different
 *   content is rejected (DuplicateEventError).
 * - An event can be revoked exactly once. Revoking an unknown id or
 *   revoking twice throws.
 * - Scores are arbitrary integers; negative totals are allowed.
 * - Ranking: higher score first; ties broken by username in UTF-8 byte
 *   order (Buffer.compare). Ranks are 1-based positions in that order.
 * - Every mutation returns the net change of the TopK window.
 * - verify() recomputes all scores and the ranking from the full ledger
 *   and cross-checks the incremental state.
 */

export interface ScoreEvent {
  readonly id: string;
  readonly username: string;
  readonly delta: number;
}

interface LedgerEntry extends ScoreEvent {
  revoked: boolean;
}

export interface TopKEntry {
  readonly rank: number;
  readonly username: string;
  readonly score: number;
}

export interface RankScore {
  readonly rank: number;
  readonly score: number;
}

export interface TopKMovement {
  readonly username: string;
  readonly from: RankScore;
  readonly to: RankScore;
}

/** Net change of the TopK window caused by one mutation. */
export interface TopKDiff {
  /** Newly entered the TopK (with new rank/score). */
  readonly entered: readonly TopKEntry[];
  /** Dropped out of the TopK (with their previous rank/score). */
  readonly left: readonly TopKEntry[];
  /** Stayed in the TopK but changed rank and/or score. */
  readonly changed: readonly TopKMovement[];
}

export class DuplicateEventError extends Error {
  constructor(id: string) {
    super(`event id "${id}" already exists with different content`);
    this.name = "DuplicateEventError";
  }
}

export class UnknownEventError extends Error {
  constructor(id: string) {
    super(`cannot revoke unknown event id "${id}"`);
    this.name = "UnknownEventError";
  }
}

export class AlreadyRevokedError extends Error {
  constructor(id: string) {
    super(`event id "${id}" was already revoked`);
    this.name = "AlreadyRevokedError";
  }
}

export class InvalidEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEventError";
  }
}

export class LedgerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LedgerMismatchError";
  }
}

/** Compare two strings by UTF-8 byte order. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

function sameEvent(a: ScoreEvent, b: ScoreEvent): boolean {
  return a.username === b.username && a.delta === b.delta;
}

export class Leaderboard {
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly scores = new Map<string, number>();
  private readonly k: number;
  private lastTopK: TopKEntry[] = [];

  constructor(k = 10) {
    if (!Number.isInteger(k) || k < 1) {
      throw new InvalidEventError(`k must be a positive integer, got ${k}`);
    }
    this.k = k;
  }

  /** Number of users with a non-zero ledger footprint. */
  get size(): number {
    return this.scores.size;
  }

  /** Current score of a user (0 if unseen or fully revoked). */
  scoreOf(username: string): number {
    return this.scores.get(username) ?? 0;
  }

  /**
   * Apply a score event. Idempotent for exact duplicates; rejects the
   * same id carrying different content. Returns the TopK net change.
   */
  apply(event: ScoreEvent): TopKDiff {
    if (typeof event.id !== "string" || event.id.length === 0) {
      throw new InvalidEventError("event id must be a non-empty string");
    }
    if (typeof event.username !== "string" || event.username.length === 0) {
      throw new InvalidEventError("username must be a non-empty string");
    }
    if (!Number.isInteger(event.delta)) {
      throw new InvalidEventError(`delta must be an integer, got ${event.delta}`);
    }

    const existing = this.ledger.get(event.id);
    if (existing !== undefined) {
      if (!sameEvent(existing, event)) {
        throw new DuplicateEventError(event.id);
      }
      return emptyDiff(); // idempotent replay, nothing changes
    }

    const before = this.lastTopK;
    this.ledger.set(event.id, { ...event, revoked: false });
    this.addScore(event.username, event.delta);
    return this.commit(before);
  }

  /**
   * Revoke an event exactly once, removing its delta from the user's
   * score. Returns the TopK net change.
   */
  revoke(id: string): TopKDiff {
    const entry = this.ledger.get(id);
    if (entry === undefined) {
      throw new UnknownEventError(id);
    }
    if (entry.revoked) {
      throw new AlreadyRevokedError(id);
    }
    const before = this.lastTopK;
    entry.revoked = true;
    this.addScore(entry.username, -entry.delta);
    return this.commit(before);
  }

  /** Current TopK window (rank 1 = best). */
  topK(k = this.k): TopKEntry[] {
    return rankAll(this.scores).slice(0, k);
  }

  /**
   * Recompute every score and the full ranking from the ledger and
   * cross-check against the incremental state. Throws
   * LedgerMismatchError on any divergence; returns the recomputed
   * full ranking otherwise.
   */
  verify(): TopKEntry[] {
    const rebuilt = new Map<string, number>();
    for (const entry of this.ledger.values()) {
      if (entry.revoked) continue;
      rebuilt.set(entry.username, (rebuilt.get(entry.username) ?? 0) + entry.delta);
    }
    for (const [user, score] of rebuilt) {
      if (score === 0) rebuilt.delete(user);
    }

    const users = new Set([...rebuilt.keys(), ...this.scores.keys()]);
    for (const user of users) {
      const expected = rebuilt.get(user);
      const actual = this.scores.get(user);
      if (expected !== actual) {
        throw new LedgerMismatchError(
          `score mismatch for "${user}": ledger=${expected ?? "<absent>"} incremental=${actual ?? "<absent>"}`,
        );
      }
    }

    const fullRanking = rankAll(rebuilt);
    const expectedTop = fullRanking.slice(0, this.k);
    if (!sameRanking(expectedTop, this.lastTopK)) {
      throw new LedgerMismatchError(
        `topK mismatch: ledger=${JSON.stringify(expectedTop)} incremental=${JSON.stringify(this.lastTopK)}`,
      );
    }
    return fullRanking;
  }

  private addScore(username: string, delta: number): void {
    const next = (this.scores.get(username) ?? 0) + delta;
    if (next === 0) {
      this.scores.delete(username);
    } else {
      this.scores.set(username, next);
    }
  }

  private commit(before: readonly TopKEntry[]): TopKDiff {
    this.lastTopK = this.topK();
    return diffTopK(before, this.lastTopK);
  }
}

function rankAll(scores: ReadonlyMap<string, number>): TopKEntry[] {
  const users = [...scores.keys()].sort((a, b) => {
    const byScore = (scores.get(b) ?? 0) - (scores.get(a) ?? 0);
    return byScore !== 0 ? byScore : compareUtf8(a, b);
  });
  return users.map((username, index) => ({
    rank: index + 1,
    username,
    score: scores.get(username) ?? 0,
  }));
}

function sameRanking(a: readonly TopKEntry[], b: readonly TopKEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (entry, i) =>
        entry.username === b[i]?.username &&
        entry.score === b[i]?.score &&
        entry.rank === b[i]?.rank,
    )
  );
}

function emptyDiff(): TopKDiff {
  return { entered: [], left: [], changed: [] };
}

/** Compute the net change between two TopK snapshots, keyed by username. */
export function diffTopK(before: readonly TopKEntry[], after: readonly TopKEntry[]): TopKDiff {
  const beforeByUser = new Map(before.map((entry) => [entry.username, entry]));
  const afterByUser = new Map(after.map((entry) => [entry.username, entry]));

  const entered: TopKEntry[] = [];
  const changed: TopKMovement[] = [];
  for (const entry of after) {
    const prev = beforeByUser.get(entry.username);
    if (prev === undefined) {
      entered.push(entry);
    } else if (prev.rank !== entry.rank || prev.score !== entry.score) {
      changed.push({
        username: entry.username,
        from: { rank: prev.rank, score: prev.score },
        to: { rank: entry.rank, score: entry.score },
      });
    }
  }

  const left: TopKEntry[] = [];
  for (const entry of before) {
    if (!afterByUser.has(entry.username)) {
      left.push(entry);
    }
  }

  return { entered, left, changed };
}
