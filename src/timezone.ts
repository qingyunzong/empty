/**
 * Offset-transition-table timezone library.
 *
 * A `TransitionTable` maps local integer seconds to UTC integer seconds using
 * only the caller-supplied offset transitions; the system timezone is never
 * consulted. All intervals are half-open `[start, end)`.
 *
 *   local = utc + offsetSeconds
 *
 * Tables are immutable. `TimezoneDatabase.replace` swaps the table atomically
 * (a single reference store); cursors and results obtained from an older table
 * keep observing that older table forever.
 */

/** A single offset change: from `utcSecond` (inclusive) on, `offsetSeconds` applies. */
export interface Transition {
  readonly utcSecond: number;
  readonly offsetSeconds: number;
}

/** A resolved offset rule: `local = utc + offsetSeconds` for UTC in [utcStart, utcEnd). */
export interface OffsetRule {
  readonly offsetSeconds: number;
  readonly utcStart: number; // inclusive, may be -Infinity
  readonly utcEnd: number; // exclusive, may be +Infinity
}

/** Result of mapping one local second to UTC. */
export type LocalToUtcResult =
  | { readonly kind: "none" } // local second falls in a gap: explicitly no solution
  | { readonly kind: "unique"; readonly utcSecond: number }
  | { readonly kind: "ambiguous"; readonly utcSeconds: readonly [number, number] }; // overlap: two candidates, ascending

/** One maximal run of a single offset rule inside an inverse-image segment. */
export interface InversePart {
  readonly utcStart: number; // inclusive
  readonly utcEnd: number; // exclusive
  readonly rule: OffsetRule; // source offset rule that produced this part
}

/**
 * One connected UTC interval of the inverse image of a local interval.
 * `parts` tiles [utcStart, utcEnd) and records the source rule of each piece.
 */
export interface InverseSegment {
  readonly utcStart: number; // inclusive
  readonly utcEnd: number; // exclusive
  readonly parts: readonly InversePart[];
}

export interface ForwardVerification {
  readonly utcStart: number;
  readonly utcEnd: number;
  readonly checked: number;
  readonly ok: boolean;
  readonly failures: readonly number[]; // first failing UTC seconds, if any
}

export interface SegmentVerification {
  readonly segment: InverseSegment;
  readonly exhaustive: boolean; // false when the domain exceeded maxExhaustive
  readonly checked: number;
  readonly ok: boolean;
  readonly failures: readonly number[];
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, got ${value}`);
  }
}

export class TransitionTable {
  readonly initialOffsetSeconds: number;
  readonly transitions: readonly Transition[];
  readonly rules: readonly OffsetRule[];

  constructor(initialOffsetSeconds: number, transitions: readonly Transition[] = []) {
    assertSafeInteger(initialOffsetSeconds, "initialOffsetSeconds");
    let previousUtc = -Infinity;
    let previousOffset = initialOffsetSeconds;
    for (const transition of transitions) {
      assertSafeInteger(transition.utcSecond, "transition.utcSecond");
      assertSafeInteger(transition.offsetSeconds, "transition.offsetSeconds");
      if (transition.utcSecond <= previousUtc) {
        throw new RangeError("transitions must be strictly increasing in utcSecond");
      }
      if (transition.offsetSeconds === previousOffset) {
        throw new RangeError("consecutive transitions must change the offset");
      }
      previousUtc = transition.utcSecond;
      previousOffset = transition.offsetSeconds;
    }

    const rules: OffsetRule[] = [];
    let start = -Infinity;
    let offset = initialOffsetSeconds;
    for (const transition of transitions) {
      rules.push(Object.freeze({ offsetSeconds: offset, utcStart: start, utcEnd: transition.utcSecond }));
      start = transition.utcSecond;
      offset = transition.offsetSeconds;
    }
    rules.push(Object.freeze({ offsetSeconds: offset, utcStart: start, utcEnd: Infinity }));

    this.initialOffsetSeconds = initialOffsetSeconds;
    this.transitions = Object.freeze(transitions.map((t) => Object.freeze({ ...t })));
    this.rules = Object.freeze(rules);
    Object.freeze(this);
  }

  static fixed(offsetSeconds: number): TransitionTable {
    return new TransitionTable(offsetSeconds);
  }

  /** The offset rule in effect at a UTC second. */
  ruleAtUtc(utcSecond: number): OffsetRule {
    assertSafeInteger(utcSecond, "utcSecond");
    let lo = 0;
    let hi = this.rules.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      const rule = this.rules[mid]!;
      if (rule.utcStart <= utcSecond) lo = mid;
      else hi = mid - 1;
    }
    return this.rules[lo]!;
  }

  /** Forward map: UTC second -> local second (always exactly one answer). */
  utcToLocal(utcSecond: number): number {
    return utcSecond + this.ruleAtUtc(utcSecond).offsetSeconds;
  }

  /**
   * Inverse map: local second -> UTC second(s).
   * Returns 0 candidates inside a gap, 2 inside an overlap, 1 otherwise.
   */
  localToUtc(localSecond: number): LocalToUtcResult {
    assertSafeInteger(localSecond, "localSecond");
    const found = new Set<number>();
    for (const rule of this.rules) {
      const utc = localSecond - rule.offsetSeconds;
      if (rule.utcStart <= utc && utc < rule.utcEnd) found.add(utc);
    }
    const candidates = [...found].sort((a, b) => a - b);
    if (candidates.length === 0) return { kind: "none" };
    if (candidates.length === 1) return { kind: "unique", utcSecond: candidates[0]! };
    return { kind: "ambiguous", utcSeconds: [candidates[0]!, candidates[1]!] };
  }

  /**
   * Inverse image of a local half-open interval [localStart, localEnd):
   * every UTC interval whose forward image lands inside the local interval.
   *
   * The image is computed per offset rule (splitting at transition points and
   * dropping local seconds that fall in a gap), then adjacent/overlapping
   * pieces are merged into connected segments. Each segment keeps the source
   * offset rule of every part.
   */
  inverseImage(localStart: number, localEnd: number): InverseSegment[] {
    assertSafeInteger(localStart, "localStart");
    assertSafeInteger(localEnd, "localEnd");
    if (localStart >= localEnd) return [];

    const segments: InverseSegment[] = [];
    for (const rule of this.rules) {
      const utcStart = Math.max(rule.utcStart, localStart - rule.offsetSeconds);
      const utcEnd = Math.min(rule.utcEnd, localEnd - rule.offsetSeconds);
      if (!(utcStart < utcEnd)) continue; // gap (or outside this rule): no contribution
      const part: InversePart = Object.freeze({ utcStart, utcEnd, rule });
      const last = segments[segments.length - 1];
      if (last && utcStart <= last.utcEnd) {
        // Adjacent or overlapping in UTC: merge into one equivalent segment.
        const parts = [...last.parts, part];
        segments[segments.length - 1] = Object.freeze({
          utcStart: last.utcStart,
          utcEnd: Math.max(last.utcEnd, utcEnd),
          parts: Object.freeze(parts),
        });
      } else {
        segments.push(Object.freeze({ utcStart, utcEnd, parts: Object.freeze([part]) }));
      }
    }
    return segments;
  }

  /**
   * Exhaustive forward-mapping verification over a (small) UTC domain:
   * for every UTC second, utcToLocal then localToUtc must round-trip.
   */
  verifyForward(utcStart: number, utcEnd: number, maxFailures = 16): ForwardVerification {
    assertSafeInteger(utcStart, "utcStart");
    assertSafeInteger(utcEnd, "utcEnd");
    if (utcStart >= utcEnd) throw new RangeError("utcStart must be < utcEnd");
    const failures: number[] = [];
    let checked = 0;
    for (let utc = utcStart; utc < utcEnd; utc++) {
      checked++;
      const local = this.utcToLocal(utc);
      const back = this.localToUtc(local);
      const roundTrips =
        (back.kind === "unique" && back.utcSecond === utc) ||
        (back.kind === "ambiguous" && back.utcSeconds.includes(utc));
      if (!roundTrips && failures.length < maxFailures) failures.push(utc);
    }
    return Object.freeze({ utcStart, utcEnd, checked, ok: failures.length === 0, failures: Object.freeze(failures) });
  }

  /** A cursor iterating this table's transitions; bound to this table version forever. */
  cursor(): TransitionCursor {
    return new TransitionCursor(this);
  }
}

/**
 * Exhaustively verify one inverse-image segment against its local interval:
 * every UTC second in the segment must forward-map into [localStart, localEnd)
 * and round-trip back. Domains larger than `maxExhaustive` are reported as
 * non-exhaustive instead of being scanned.
 */
export function verifySegment(
  table: TransitionTable,
  segment: InverseSegment,
  localStart: number,
  localEnd: number,
  maxExhaustive = 1_000_000,
  maxFailures = 16,
): SegmentVerification {
  const size = segment.utcEnd - segment.utcStart;
  if (size > maxExhaustive) {
    return Object.freeze({ segment, exhaustive: false, checked: 0, ok: false, failures: Object.freeze([]) });
  }
  const failures: number[] = [];
  let checked = 0;
  for (let utc = segment.utcStart; utc < segment.utcEnd; utc++) {
    checked++;
    const local = table.utcToLocal(utc);
    const inRange = localStart <= local && local < localEnd;
    const back = table.localToUtc(local);
    const roundTrips =
      (back.kind === "unique" && back.utcSecond === utc) ||
      (back.kind === "ambiguous" && back.utcSeconds.includes(utc));
    if ((!inRange || !roundTrips) && failures.length < maxFailures) failures.push(utc);
  }
  return Object.freeze({ segment, exhaustive: true, checked, ok: failures.length === 0, failures: Object.freeze(failures) });
}

/** Iterates the transitions of one immutable table version. */
export class TransitionCursor {
  readonly table: TransitionTable;
  #index = 0;

  constructor(table: TransitionTable) {
    this.table = table;
  }

  get position(): number {
    return this.#index;
  }

  peek(): Transition | undefined {
    return this.table.transitions[this.#index];
  }

  next(): Transition | undefined {
    const transition = this.table.transitions[this.#index];
    if (transition !== undefined) this.#index++;
    return transition;
  }

  reset(): void {
    this.#index = 0;
  }
}

/**
 * Holds the current transition table. `replace` is a single reference store,
 * so readers always observe one consistent immutable table; cursors and
 * results created before a replace keep using the old table.
 */
export class TimezoneDatabase {
  #current: TransitionTable;

  constructor(initial: TransitionTable) {
    this.#current = initial;
  }

  get current(): TransitionTable {
    return this.#current;
  }

  /** Atomically swap the table; returns the previous table. */
  replace(next: TransitionTable): TransitionTable {
    const previous = this.#current;
    this.#current = next;
    return previous;
  }

  /** A cursor bound to the table version current at call time. */
  cursor(): TransitionCursor {
    return new TransitionCursor(this.#current);
  }

  utcToLocal(utcSecond: number): number {
    return this.#current.utcToLocal(utcSecond);
  }

  localToUtc(localSecond: number): LocalToUtcResult {
    return this.#current.localToUtc(localSecond);
  }

  inverseImage(localStart: number, localEnd: number): InverseSegment[] {
    return this.#current.inverseImage(localStart, localEnd);
  }
}
