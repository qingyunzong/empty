/**
 * Deterministic, embeddable connection-pool state machine for a channel layer.
 *
 * The pool owns no sockets and no timers.  The embedding layer drives time via
 * `advance`/`advanceTo`, starts connection attempts returned from `add` and
 * `advance`, and reports their outcome with the attempt token it was given.
 * Keeping the tokens in the event API is what makes late completions harmless.
 */

export type ConnectionState =
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed";

export interface BackoffOptions {
  /** Delay before the first reconnect attempt. */
  baseMs: number;
  /** Multiplier applied for every consecutive failure. */
  factor: number;
  /** Upper bound for a reconnect delay. */
  maxMs: number;
}

export interface ConnectionPoolOptions {
  backoff?: Partial<BackoffOptions>;
}

export interface ConnectionAttempt {
  readonly id: string;
  readonly attempt: number;
  readonly at: number;
}

export interface HealthCheckTicket {
  readonly id: string;
  readonly attempt: number;
  readonly token: number;
}

export interface ConnectionSnapshot {
  readonly id: string;
  readonly state: ConnectionState;
  /** Monotonic token for the current (or most recent) connection attempt. */
  readonly attempt: number;
  /** Consecutive failures since the connection was last ready. */
  readonly failures: number;
  /** Absolute time of the next reconnect attempt, or null. */
  readonly retryAt: number | null;
  /** A health check is in flight while the connection is still ready. */
  readonly checking: boolean;
  /** Token that a health-check completion must echo back. */
  readonly checkToken: number;
}

export interface PoolSnapshot {
  readonly now: number;
  /** Ready members in stable id order. */
  readonly readyIds: readonly string[];
  /** Always equal to `readyIds.length`. */
  readonly readyCount: number;
  /** Alias of `readyIds`; the set eligible for load selection. */
  readonly availableIds: readonly string[];
  /** All members in stable id order. */
  readonly members: readonly ConnectionSnapshot[];
}

const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: 100,
  factor: 2,
  maxMs: 30_000,
};

interface MutableMember {
  id: string;
  state: ConnectionState;
  attempt: number;
  failures: number;
  retryAt: number | null;
  checking: boolean;
  checkToken: number;
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

function validateBackoff(options: BackoffOptions): BackoffOptions {
  if (!Number.isFinite(options.baseMs) || options.baseMs <= 0) {
    throw new RangeError("backoff.baseMs must be a finite positive number");
  }
  if (!Number.isFinite(options.factor) || options.factor < 1) {
    throw new RangeError("backoff.factor must be a finite number >= 1");
  }
  if (!Number.isFinite(options.maxMs) || options.maxMs < options.baseMs) {
    throw new RangeError(
      "backoff.maxMs must be finite and greater than or equal to baseMs",
    );
  }
  return { ...options };
}

/**
 * Pure backoff schedule. `failures` is one-based: the first failure waits
 * `baseMs`, the second `baseMs * factor`, and so on, capped by `maxMs`.
 * There is deliberately no jitter so repeated event sequences are identical.
 */
export function computeBackoffDelay(
  failures: number,
  options: BackoffOptions,
): number {
  if (!Number.isInteger(failures) || failures < 1) {
    throw new RangeError("failures must be a positive integer");
  }
  const exponent = failures - 1;
  const raw = options.baseMs * Math.pow(options.factor, exponent);
  return Math.min(options.maxMs, raw);
}

/** FNV-1a over UTF-16 code units. Stable across engines and locales. */
function stableHash(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class ConnectionPool {
  readonly #members = new Map<string, MutableMember>();
  readonly #backoff: BackoffOptions;
  #now = 0;
  #lastSelectedId: string | null = null;

  constructor(options: ConnectionPoolOptions = {}) {
    const provided = options.backoff ?? {};
    this.#backoff = validateBackoff({
      baseMs: provided.baseMs ?? DEFAULT_BACKOFF.baseMs,
      factor: provided.factor ?? DEFAULT_BACKOFF.factor,
      maxMs: provided.maxMs ?? DEFAULT_BACKOFF.maxMs,
    });
  }

  get now(): number {
    return this.#now;
  }

  get size(): number {
    return this.#members.size;
  }

  get readyCount(): number {
    return this.#readyIds().length;
  }

  /** Ready members in stable id order. This is the only selectable set. */
  get readyIds(): readonly string[] {
    return this.#readyIds();
  }

  /** Alias kept explicit so callers cannot accidentally use a stale count. */
  get availableIds(): readonly string[] {
    return this.#readyIds();
  }

  /** Earliest pending reconnect time, or null when no timer is pending. */
  get nextRetryAt(): number | null {
    let next: number | null = null;
    for (const member of this.#members.values()) {
      if (
        member.state === "reconnecting" &&
        member.retryAt !== null &&
        (next === null || member.retryAt < next)
      ) {
        next = member.retryAt;
      }
    }
    return next;
  }

  /**
   * Register a member and start its first connection attempt.
   * The embedding layer must eventually call `connected` or `failed` with the
   * returned attempt number.
   */
  add(id: string): ConnectionAttempt {
    if (typeof id !== "string" || id.length === 0) {
      throw new TypeError("connection id must be a non-empty string");
    }
    if (this.#members.has(id)) {
      throw new Error(`connection "${id}" already exists`);
    }
    const member: MutableMember = {
      id,
      state: "connecting",
      attempt: 1,
      failures: 0,
      retryAt: null,
      checking: false,
      checkToken: 0,
    };
    this.#members.set(id, member);
    return { id, attempt: member.attempt, at: this.#now };
  }

  /** Remove a member. Late events for it are ignored. */
  remove(id: string): boolean {
    const removed = this.#members.delete(id);
    if (removed && this.#lastSelectedId === id) {
      this.#lastSelectedId = null;
    }
    return removed;
  }

  /** Permanently close a member while retaining it in snapshots. */
  close(id: string): boolean {
    const member = this.#members.get(id);
    if (member === undefined || member.state === "closed") {
      return false;
    }
    member.state = "closed";
    member.retryAt = null;
    member.checking = false;
    member.checkToken += 1;
    return true;
  }

  has(id: string): boolean {
    return this.#members.has(id);
  }

  /** Current attempt token, including the last failed attempt while backing off. */
  attemptOf(id: string): number | null {
    return this.#members.get(id)?.attempt ?? null;
  }

  get(id: string): ConnectionSnapshot | undefined {
    const member = this.#members.get(id);
    return member === undefined ? undefined : snapshotMember(member);
  }

  /**
   * Report a successful connection for a specific attempt. Stale or duplicate
   * completions are ignored and return false.
   */
  connected(id: string, attempt: number): boolean {
    const member = this.#members.get(id);
    if (
      member === undefined ||
      member.state !== "connecting" ||
      member.attempt !== attempt
    ) {
      return false;
    }
    member.state = "ready";
    member.failures = 0;
    member.retryAt = null;
    member.checking = false;
    member.checkToken += 1;
    return true;
  }

  /**
   * Report a failed connection (or a lost ready connection) for a specific
   * attempt. Only the first failure for an attempt schedules a retry; stale or
   * duplicate reports cannot move the retry deadline.
   */
  failed(id: string, attempt: number): boolean {
    const member = this.#members.get(id);
    if (
      member === undefined ||
      (member.state !== "connecting" && member.state !== "ready") ||
      member.attempt !== attempt
    ) {
      return false;
    }

    member.failures = member.state === "ready" ? 1 : member.failures + 1;
    member.state = "reconnecting";
    member.retryAt =
      this.#now + computeBackoffDelay(member.failures, this.#backoff);
    member.checking = false;
    member.checkToken += 1;
    return true;
  }

  /**
   * Advance the logical clock and return every reconnect attempt that became
   * due. A member moves from `reconnecting` to `connecting` exactly once per
   * scheduled deadline; without a new failure it cannot schedule another one.
   */
  advance(ms: number): ConnectionAttempt[] {
    assertFiniteNonNegative(ms, "ms");
    return this.advanceTo(this.#now + ms);
  }

  advanceTo(time: number): ConnectionAttempt[] {
    assertFiniteNonNegative(time, "time");
    if (time < this.#now) {
      throw new RangeError("logical time cannot move backwards");
    }
    this.#now = time;

    const due: MutableMember[] = [];
    for (const member of this.#members.values()) {
      if (
        member.state === "reconnecting" &&
        member.retryAt !== null &&
        member.retryAt <= time
      ) {
        due.push(member);
      }
    }
    due.sort(
      (a, b) => (a.retryAt as number) - (b.retryAt as number) ||
        compareIds(a.id, b.id),
    );

    const attempts: ConnectionAttempt[] = [];
    for (const member of due) {
      member.state = "connecting";
      member.attempt += 1;
      member.retryAt = null;
      member.checkToken += 1;
      attempts.push({ id: member.id, attempt: member.attempt, at: time });
    }
    return attempts;
  }

  /**
   * Start a health check against a ready member. Only one check per member can
   * be in flight. The member stays selectable until a failure is reported.
   */
  beginHealthCheck(id: string): HealthCheckTicket | null {
    const member = this.#members.get(id);
    if (
      member === undefined ||
      member.state !== "ready" ||
      member.checking
    ) {
      return null;
    }
    member.checking = true;
    member.checkToken += 1;
    return {
      id,
      attempt: member.attempt,
      token: member.checkToken,
    };
  }

  /**
   * Complete an in-flight health check. A stale ticket (older attempt or older
   * health-check token) is ignored without touching state, which prevents a
   * late probe from pulling a freshly reconnected member back out of `ready`.
   */
  completeHealthCheck(ticket: HealthCheckTicket, healthy: boolean): boolean {
    const member = this.#members.get(ticket.id);
    if (
      member === undefined ||
      member.state !== "ready" ||
      !member.checking ||
      member.attempt !== ticket.attempt ||
      member.checkToken !== ticket.token
    ) {
      return false;
    }

    member.checking = false;
    member.checkToken += 1;
    if (healthy) {
      return true;
    }

    member.failures = 1;
    member.state = "reconnecting";
    member.retryAt =
      this.#now + computeBackoffDelay(member.failures, this.#backoff);
    return true;
  }

  /**
   * Deterministic round-robin selection over ready members. The cursor tracks
   * the last selected id, so readiness changes do not reset fairness.
   */
  select(): string | null {
    const members = this.#sortedMembers();
    if (members.length === 0) {
      return null;
    }

    let start = 0;
    if (this.#lastSelectedId !== null) {
      const index = members.findIndex(
        (member) => member.id === this.#lastSelectedId,
      );
      start = index === -1 ? 0 : index + 1;
    }

    for (let offset = 0; offset < members.length; offset += 1) {
      const member = members[(start + offset) % members.length];
      if (member.state === "ready") {
        this.#lastSelectedId = member.id;
        return member.id;
      }
    }
    return null;
  }

  /**
   * Stable key-affinity selection. The same key and ready set always choose the
   * same member, independent of call history.
   */
  selectForKey(key: string): string | null {
    if (typeof key !== "string") {
      throw new TypeError("key must be a string");
    }
    const ids = this.#readyIds();
    if (ids.length === 0) {
      return null;
    }

    let bestId = ids[0];
    let bestScore = stableHash(`${key}\u0000${bestId}`);
    for (let index = 1; index < ids.length; index += 1) {
      const id = ids[index];
      const score = stableHash(`${key}\u0000${id}`);
      if (score > bestScore || (score === bestScore && id < bestId)) {
        bestId = id;
        bestScore = score;
      }
    }
    return bestId;
  }

  snapshot(): PoolSnapshot {
    const members = this.#sortedMembers().map(snapshotMember);
    const readyIds = members
      .filter((member) => member.state === "ready")
      .map((member) => member.id);
    return {
      now: this.#now,
      readyIds,
      readyCount: readyIds.length,
      availableIds: readyIds,
      members,
    };
  }

  #sortedMembers(): MutableMember[] {
    return [...this.#members.values()].sort((a, b) => compareIds(a.id, b.id));
  }

  #readyIds(): string[] {
    return this.#sortedMembers()
      .filter((member) => member.state === "ready")
      .map((member) => member.id);
  }
}

function snapshotMember(member: MutableMember): ConnectionSnapshot {
  return {
    id: member.id,
    state: member.state,
    attempt: member.attempt,
    failures: member.failures,
    retryAt: member.retryAt,
    checking: member.checking,
    checkToken: member.checkToken,
  };
}
