/**
 * peg-cut：支持序列、优先选择、重复与显式 cut 的 PEG 语法库。
 *
 * 语义要点：
 * - 优先选择（alt）：按顺序尝试分支，第一个成功的分支生效。
 * - cut：本身零消费恒成功，但会把“已提交”标志带入结果；同一 seq 中
 *   其后的失败会变成“已提交失败”（committed failure）。
 * - cut 作用域为最近的封闭选择点（alt / rep）：分支成功时该选择点
 *   消费掉 cut 标志（不再向上泄漏）；分支已提交失败时，失败穿透一切
 *   算子传播到顶层，任何选择算子都不得再尝试后备分支。
 * - 重复（rep）：循环体零消费成功属于语法错误，抛出 GrammarError。
 *
 * 记忆化安全性：
 * - Result（成功/失败）内部携带 cut 标志，解析结果只取决于
 *   (parser, pos)，不依赖任何外部可变的 cut 状态；因此按 (parser, pos)
 *   缓存是安全的，cut 作用域无需也不会进入缓存键。
 */

export class GrammarError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrammarError";
  }
}

export interface Success {
  ok: true;
  pos: number;
  /** 本次匹配过程中是否跨过了 cut */
  cut: boolean;
}

export interface Failure {
  ok: false;
  /** true 表示已提交失败：选择算子不得再尝试后备分支 */
  cut: boolean;
}

export type Result = Success | Failure;

export interface FailureInfo {
  /** 最远失败位置 */
  pos: number;
  /** 在该位置期望的终结符集合 */
  expected: string[];
}

export interface ParseOutcome {
  ok: boolean;
  /** 成功时为结束位置；失败时为 0 */
  pos: number;
  /** 失败是否为 cut 造成的已提交失败 */
  committed: boolean;
  /** 最远失败集合（成功时同样可用，用于提示） */
  failure: FailureInfo;
  /** 实际执行的 (parser, pos) 求值次数，用于验证记忆化生效 */
  evals: number;
}

export interface Parser {
  run(state: State, pos: number): Result;
}

export class State {
  farPos = 0;
  readonly expected = new Set<string>();
  evals = 0;
  private readonly cache = new Map<Parser, Map<number, Result>>();

  constructor(
    readonly input: string,
    readonly memo: boolean,
  ) {}

  record(pos: number, expected: string): void {
    if (pos > this.farPos) {
      this.farPos = pos;
      this.expected.clear();
      this.expected.add(expected);
    } else if (pos === this.farPos) {
      this.expected.add(expected);
    }
  }

  eval(p: Parser, pos: number): Result {
    if (this.memo) {
      let byPos = this.cache.get(p);
      if (byPos === undefined) {
        byPos = new Map();
        this.cache.set(p, byPos);
      } else {
        const hit = byPos.get(pos);
        if (hit !== undefined) return hit;
      }
      this.evals++;
      const r = p.run(this, pos);
      byPos.set(pos, r);
      return r;
    }
    this.evals++;
    return p.run(this, pos);
  }
}

class Lit implements Parser {
  constructor(readonly text: string) {}
  run(state: State, pos: number): Result {
    if (state.input.startsWith(this.text, pos)) {
      return { ok: true, pos: pos + this.text.length, cut: false };
    }
    state.record(pos, JSON.stringify(this.text));
    return { ok: false, cut: false };
  }
}

class Re implements Parser {
  private readonly re: RegExp;
  constructor(
    source: RegExp,
    readonly label: string,
  ) {
    const flags = source.flags.includes("y") ? source.flags : source.flags + "y";
    this.re = new RegExp(source.source, flags);
  }
  run(state: State, pos: number): Result {
    this.re.lastIndex = pos;
    const m = this.re.exec(state.input);
    if (m !== null) return { ok: true, pos: pos + m[0].length, cut: false };
    state.record(pos, this.label);
    return { ok: false, cut: false };
  }
}

class Seq implements Parser {
  constructor(readonly parts: Parser[]) {}
  run(state: State, pos: number): Result {
    let cut = false;
    let cur = pos;
    for (const part of this.parts) {
      const r = state.eval(part, cur);
      if (!r.ok) return { ok: false, cut: cut || r.cut };
      cut = cut || r.cut;
      cur = r.pos;
    }
    return { ok: true, pos: cur, cut };
  }
}

class Alt implements Parser {
  constructor(readonly branches: Parser[]) {}
  run(state: State, pos: number): Result {
    for (const branch of this.branches) {
      const r = state.eval(branch, pos);
      // 分支成功：本选择点是 cut 作用域边界，消费掉 cut 标志
      if (r.ok) return r.cut ? { ok: true, pos: r.pos, cut: false } : r;
      if (r.cut) return r; // 已提交失败：不再尝试后备分支
    }
    return { ok: false, cut: false };
  }
}

class Rep implements Parser {
  constructor(
    readonly body: Parser,
    readonly min: number,
  ) {}
  run(state: State, pos: number): Result {
    let cur = pos;
    let count = 0;
    for (;;) {
      const r = state.eval(this.body, cur);
      if (!r.ok) {
        if (r.cut) return r; // 已提交失败穿透重复
        // rep 自身是 cut 作用域边界：成功返回时消费掉 cut 标志
        if (count < this.min) return { ok: false, cut: false };
        return { ok: true, pos: cur, cut: false };
      }
      if (r.pos === cur) {
        throw new GrammarError(
          "repetition body succeeded without consuming input (nullable body)",
        );
      }
      cur = r.pos;
      count++;
    }
  }
}

class CutP implements Parser {
  run(_state: State, pos: number): Result {
    return { ok: true, pos, cut: true };
  }
}

class Eps implements Parser {
  run(_state: State, pos: number): Result {
    return { ok: true, pos, cut: false };
  }
}

class Eof implements Parser {
  run(state: State, pos: number): Result {
    if (pos === state.input.length) return { ok: true, pos, cut: false };
    state.record(pos, "<eof>");
    return { ok: false, cut: false };
  }
}

class Lazy implements Parser {
  private inner: Parser | undefined;
  constructor(private readonly thunk: () => Parser) {}
  run(state: State, pos: number): Result {
    this.inner ??= this.thunk();
    return state.eval(this.inner, pos);
  }
}

export function lit(text: string): Parser {
  return new Lit(text);
}

export function re(source: RegExp, label?: string): Parser {
  return new Re(source, label ?? `/${source.source}/`);
}

export function seq(...parts: Parser[]): Parser {
  return new Seq(parts);
}

export function alt(...branches: Parser[]): Parser {
  return new Alt(branches);
}

export function rep(body: Parser, min = 0): Parser {
  return new Rep(body, min);
}

export function opt(p: Parser): Parser {
  return new Alt([p, new Eps()]);
}

export function lazy(thunk: () => Parser): Parser {
  return new Lazy(thunk);
}

/** 显式 cut：零消费恒成功，把其后的失败提交为不可回溯 */
export const cut: Parser = new CutP();
export const eps: Parser = new Eps();
export const eof: Parser = new Eof();

export function parse(
  p: Parser,
  input: string,
  opts: { memo?: boolean } = {},
): ParseOutcome {
  const state = new State(input, opts.memo ?? true);
  const r = state.eval(p, 0);
  const failure: FailureInfo = { pos: state.farPos, expected: [...state.expected] };
  if (r.ok) {
    return { ok: true, pos: r.pos, committed: r.cut, failure, evals: state.evals };
  }
  return { ok: false, pos: 0, committed: r.cut, failure, evals: state.evals };
}
