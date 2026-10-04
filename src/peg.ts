/**
 * PEG combinator library: sequence, prioritized choice, repetition and an
 * explicit cut operator, with packrat memoization and farthest-failure
 * reporting.
 *
 * Cut semantics (Mizushima et al.): a cut commits to the current branch of
 * the nearest dynamically enclosing choice. Once a cut has been consumed,
 * a later failure in that branch does not try the remaining alternatives of
 * the owning choice. The owning choice absorbs the cut: the failure (or
 * success) it produces is ordinary again for outer choices, so outer
 * alternatives may still be tried.
 *
 * Every parse result carries a `cut` flag meaning "an as-yet unowned cut
 * was consumed while producing this result". Memo entries store the flag
 * together with the result, so a cache hit replays the exact same cut
 * effect a fresh evaluation would have produced.
 */

export class GrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrammarError';
  }
}

export type Value = unknown;

interface Ok {
  readonly ok: true;
  readonly pos: number;
  readonly val: Value;
  readonly cut: boolean;
}

interface Fail {
  readonly ok: false;
  readonly pos: number;
  readonly cut: boolean;
}

type Res = Ok | Fail;

export type Parser = (ctx: Ctx, pos: number) => Res;

const IN_PROGRESS = Symbol('in-progress');

interface MemoEntry {
  readonly res: Res;
  readonly log: ReadonlyArray<readonly [number, string]>;
}

type MemoSlot = MemoEntry | typeof IN_PROGRESS;

export interface ParseError {
  readonly pos: number;
  readonly expected: readonly string[];
}

export interface ParseStats {
  readonly memoHits: number;
  readonly memoMisses: number;
}

export type ParseResult =
  | { readonly ok: true; readonly value: Value; readonly stats: ParseStats }
  | { readonly ok: false; readonly error: ParseError; readonly stats: ParseStats };

export class Ctx {
  farthest = -1;
  expected: Set<string> = new Set();
  hits = 0;
  misses = 0;
  readonly active: Set<string> = new Set();
  private readonly log: Array<readonly [number, string]> = [];

  constructor(
    readonly input: string,
    readonly rules: ReadonlyMap<string, Parser>,
    readonly memo: Map<string, Map<number, MemoSlot>> | null,
  ) {}

  record(pos: number, expected: string): void {
    this.log.push([pos, expected]);
    this.apply(pos, expected);
  }

  private apply(pos: number, expected: string): void {
    if (pos > this.farthest) {
      this.farthest = pos;
      this.expected = new Set([expected]);
    } else if (pos === this.farthest) {
      this.expected.add(expected);
    }
  }

  replay(entries: ReadonlyArray<readonly [number, string]>): void {
    for (const [pos, expected] of entries) this.apply(pos, expected);
  }

  markLog(): number {
    return this.log.length;
  }

  sliceLog(mark: number): ReadonlyArray<readonly [number, string]> {
    return this.log.slice(mark);
  }
}

/** Matches a literal string. */
export function lit(text: string): Parser {
  if (text.length === 0) {
    throw new GrammarError('lit() requires a non-empty literal');
  }
  return (ctx, pos) => {
    if (ctx.input.startsWith(text, pos)) {
      return { ok: true, pos: pos + text.length, val: text, cut: false };
    }
    ctx.record(pos, JSON.stringify(text));
    return { ok: false, pos, cut: false };
  };
}

/** Matches the end of input. */
export function eof(): Parser {
  return (ctx, pos) => {
    if (pos === ctx.input.length) {
      return { ok: true, pos, val: null, cut: false };
    }
    ctx.record(pos, '<end of input>');
    return { ok: false, pos, cut: false };
  };
}

/** Always succeeds without consuming input. */
export function eps(): Parser {
  return (_ctx, pos) => ({ ok: true, pos, val: null, cut: false });
}

/** Commits to the current branch of the nearest enclosing choice. */
export function cut(): Parser {
  return (_ctx, pos) => ({ ok: true, pos, val: null, cut: true });
}

/** Sequence: all parts must match in order. */
export function seq(...parts: Parser[]): Parser {
  return (ctx, pos) => {
    const vals: Value[] = [];
    let cutSeen = false;
    let p = pos;
    for (const part of parts) {
      const r = part(ctx, p);
      if (!r.ok) return { ok: false, pos: r.pos, cut: cutSeen || r.cut };
      cutSeen = cutSeen || r.cut;
      vals.push(r.val);
      p = r.pos;
    }
    return { ok: true, pos: p, val: vals, cut: cutSeen };
  };
}

/**
 * Prioritized choice: branches are tried in order; the first success wins.
 * A failure after a cut inside a branch is final (remaining branches are
 * skipped). This choice owns any cut consumed inside it, so the result it
 * returns never carries an unowned cut flag.
 */
export function alt(...branches: Parser[]): Parser {
  if (branches.length === 0) {
    throw new GrammarError('alt() requires at least one branch');
  }
  return (ctx, pos) => {
    let last: Fail = { ok: false, pos, cut: false };
    for (const branch of branches) {
      const r = branch(ctx, pos);
      if (r.ok) return { ok: true, pos: r.pos, val: r.val, cut: false };
      if (r.cut) return { ok: false, pos: r.pos, cut: false };
      last = r;
    }
    return last;
  };
}

/**
 * Zero or more repetitions. A body failure ends the repetition, unless the
 * body consumed a cut, in which case the failure propagates. A body that
 * succeeds without consuming input is a grammar error (it would loop
 * forever), reported as a GrammarError.
 */
export function rep(body: Parser): Parser {
  return (ctx, pos) => {
    const vals: Value[] = [];
    let cutSeen = false;
    let p = pos;
    for (;;) {
      const r = body(ctx, p);
      if (!r.ok) {
        if (r.cut) return { ok: false, pos: r.pos, cut: true };
        break;
      }
      if (r.pos === p) {
        throw new GrammarError(
          'rep() body succeeded without consuming input (zero-consumption repetition)',
        );
      }
      cutSeen = cutSeen || r.cut;
      vals.push(r.val);
      p = r.pos;
    }
    return { ok: true, pos: p, val: vals, cut: cutSeen };
  };
}

/** Optional: `alt(p, eps())`. */
export function opt(p: Parser): Parser {
  return alt(p, eps());
}

/**
 * Reference to a named rule. Rule calls are the memoization unit: with
 * memoization enabled, results (including the cut flag and the farthest-
 * failure contributions) are cached per (rule, position). Direct left
 * recursion is reported as a GrammarError.
 */
export function ref(name: string): Parser {
  return (ctx, pos) => {
    const body = ctx.rules.get(name);
    if (!body) throw new GrammarError(`undefined rule: ${name}`);
    const key = `${name}@${pos}`;
    if (ctx.active.has(key)) {
      throw new GrammarError(`left recursion detected in rule '${name}'`);
    }
    const table = ctx.memo;
    if (!table) {
      ctx.active.add(key);
      try {
        return body(ctx, pos);
      } finally {
        ctx.active.delete(key);
      }
    }
    let m = table.get(name);
    if (!m) {
      m = new Map();
      table.set(name, m);
    }
    const hit = m.get(pos);
    if (hit === IN_PROGRESS) {
      throw new GrammarError(`left recursion detected in rule '${name}'`);
    }
    if (hit) {
      ctx.hits += 1;
      ctx.replay(hit.log);
      return hit.res;
    }
    ctx.misses += 1;
    m.set(pos, IN_PROGRESS);
    const mark = ctx.markLog();
    const res = body(ctx, pos);
    m.set(pos, { res, log: ctx.sliceLog(mark) });
    return res;
  };
}

export interface Grammar {
  readonly rules: ReadonlyMap<string, Parser>;
  readonly start: string;
}

export function grammar(rules: Record<string, Parser>, start: string): Grammar {
  if (!(start in rules)) throw new GrammarError(`undefined start rule: ${start}`);
  return { rules: new Map(Object.entries(rules)), start };
}

export interface ParseOptions {
  /** Packrat memoization, enabled by default. */
  readonly memo?: boolean;
}

/**
 * Parses the whole input with the grammar's start rule. On failure, reports
 * the farthest position reached together with the set of terminals expected
 * there.
 */
export function parse(g: Grammar, input: string, opts: ParseOptions = {}): ParseResult {
  const start = g.rules.get(g.start);
  if (!start) throw new GrammarError(`undefined start rule: ${g.start}`);
  const ctx = new Ctx(input, g.rules, opts.memo === false ? null : new Map());
  const r = start(ctx, 0);
  let failed = !r.ok;
  if (r.ok && r.pos !== input.length) {
    ctx.record(r.pos, '<end of input>');
    failed = true;
  }
  const stats: ParseStats = { memoHits: ctx.hits, memoMisses: ctx.misses };
  if (!failed && r.ok) return { ok: true, value: r.val, stats };
  return {
    ok: false,
    error: { pos: ctx.farthest, expected: [...ctx.expected].sort() },
    stats,
  };
}
