import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  GrammarError,
  Parser,
  ParseOutcome,
  alt,
  cut,
  eof,
  lazy,
  lit,
  opt,
  parse,
  re,
  rep,
  seq,
} from "../src/peg.js";

const both = (p: Parser, input: string): { m: ParseOutcome; n: ParseOutcome } => ({
  m: parse(p, input, { memo: true }),
  n: parse(p, input, { memo: false }),
});

describe("序列与终结符", () => {
  test("字面量序列匹配与失败位置", () => {
    const g = seq(lit("a"), lit("b"));
    const ok = parse(g, "ab");
    assert.equal(ok.ok, true);
    assert.equal(ok.pos, 2);

    const bad = parse(g, "ac");
    assert.equal(bad.ok, false);
    assert.equal(bad.committed, false);
    assert.deepEqual(bad.failure, { pos: 1, expected: ['"b"'] });
  });

  test("正则终结符", () => {
    const g = seq(re(/\d+/, "number"), lit("!"));
    const r = parse(g, "123!");
    assert.equal(r.ok, true);
    assert.equal(r.pos, 4);
  });
});

describe("优先选择", () => {
  test("分支按优先级顺序生效", () => {
    // 短分支在前：只消费 "a"
    assert.equal(parse(alt(lit("a"), lit("ab")), "ab").pos, 1);
    // 长分支在前：消费 "ab"
    assert.equal(parse(alt(lit("ab"), lit("a")), "ab").pos, 2);
  });

  test("普通失败会回退到后备分支", () => {
    const g = alt(seq(lit("a"), lit("b")), lit("ac"));
    const r = parse(g, "ac");
    assert.equal(r.ok, true);
    assert.equal(r.pos, 2);
  });
});

describe("重复", () => {
  test("零次或多次", () => {
    assert.equal(parse(rep(lit("a")), "aaab").pos, 3);
    assert.equal(parse(rep(lit("a")), "bbb").pos, 0);
  });

  test("最小次数约束", () => {
    assert.equal(parse(rep(lit("a"), 2), "ab").ok, false);
    assert.equal(parse(rep(lit("a"), 2), "aa").ok, true);
  });

  test("循环体零消费报语法错误（两种解释器一致）", () => {
    for (const g of [rep(opt(lit("a"))), rep(rep(lit("a"))), rep(re(/a*/))]) {
      assert.throws(() => parse(g, "aa", { memo: true }), GrammarError);
      assert.throws(() => parse(g, "aa", { memo: false }), GrammarError);
    }
  });
});

describe("显式 cut", () => {
  test("cut 后失败不尝试后备分支", () => {
    const withCut = alt(seq(lit("a"), cut, lit("b")), lit("a"));
    const r = parse(withCut, "a");
    assert.equal(r.ok, false);
    assert.equal(r.committed, true);
    assert.deepEqual(r.failure, { pos: 1, expected: ['"b"'] });

    // 对照：去掉 cut 后同一输入可由后备分支匹配
    const noCut = alt(seq(lit("a"), lit("b")), lit("a"));
    assert.equal(parse(noCut, "a").ok, true);
  });

  test("cut 前的失败仍可回溯", () => {
    const g = alt(seq(lit("x"), cut, lit("y")), lit("ab"));
    const r = parse(g, "ab");
    assert.equal(r.ok, true);
    assert.equal(r.pos, 2);
  });

  test("已提交失败穿透 rep 与外层选择直到顶层", () => {
    const g = alt(seq(rep(seq(lit("a"), cut, lit("b"))), lit("!")), lit("a"));
    const r = parse(g, "aab");
    assert.equal(r.ok, false);
    assert.equal(r.committed, true);

    // 对照：无 cut 时 rep 在软失败处停止，外层选择可回退到后备分支
    const noCut = alt(seq(rep(seq(lit("a"), lit("b"))), lit("!")), lit("a"));
    const r2 = parse(noCut, "aab");
    assert.equal(r2.ok, true);
    assert.equal(r2.pos, 1);
  });
});

describe("记忆化与 cut 作用域", () => {
  test("缓存命中不被先前 cut 上下文污染", () => {
    // lit("a")@0 会先在含 cut 的分支中求值并被缓存，
    // 再在其它分支中命中缓存；两种解释器结果必须一致。
    const g = alt(seq(lit("a"), cut, lit("b")), seq(lit("a"), lit("c")));
    const { m, n } = both(g, "ac");
    assert.equal(m.ok, false);
    assert.equal(m.committed, true);
    assert.deepEqual(
      { ok: m.ok, pos: m.pos, committed: m.committed, failure: m.failure },
      { ok: n.ok, pos: n.pos, committed: n.committed, failure: n.failure },
    );
  });

  test("cut 标志随缓存结果一起保存与回放", () => {
    // shared 的结果为 cut=true 的成功；缓存后回放时 seq 仍须把后续失败提交。
    const shared = seq(lit("a"), cut);
    const g = seq(alt(lit("x"), lit("a")), shared, shared, lit("b"));
    const { m, n } = both(g, "aaa");
    assert.equal(m.ok, false);
    assert.equal(m.committed, true);
    assert.equal(n.committed, true);
    assert.deepEqual(m.failure, n.failure);
  });

  test("记忆化确实减少重复求值", () => {
    const a = lit("a"); // 共享同一子解析器，缓存按解析器对象键控
    const g = alt(seq(a, lit("b")), seq(a, lit("c")));
    const { m, n } = both(g, "ac");
    assert.equal(n.evals, 7); // alt + 2*seq + 2*lit(a)@0 + lit(b)@1 + lit(c)@1
    assert.equal(m.evals, 6); // lit(a)@0 命中缓存
    assert.ok(m.evals < n.evals);
  });
});

describe("cut 作用域在分支成功处封闭", () => {
  test("内层 cut 不污染外层后续兄弟的软失败", () => {
    // 内层 alt 的第一分支成功（内部跨过 cut），cut 在 alt 处被消费；
    // 后续兄弟的软失败不应被提交，外层 alt 仍可回退。
    const g = seq(
      alt(seq(lit("a"), cut, lit("b")), lit("a")),
      alt(lit("c"), lit("d")),
    );
    const { m, n } = both(g, "abd");
    for (const r of [m, n]) {
      assert.equal(r.ok, true);
      assert.equal(r.pos, 3);
      assert.equal(r.committed, false);
    }
  });
});

describe("最远失败集合", () => {
  test("汇集同一最远位置的全部期望", () => {
    const g = alt(seq(lit("a"), lit("b")), seq(lit("a"), lit("c")));
    const r = parse(g, "ad");
    assert.equal(r.ok, false);
    assert.deepEqual(r.failure, { pos: 1, expected: ['"b"', '"c"'] });
  });

  test("更远失败会重置集合", () => {
    const g = alt(seq(lit("a"), lit("b")), seq(lit("x"), lit("y")));
    const r = parse(g, "ac");
    assert.deepEqual(r.failure, { pos: 1, expected: ['"b"'] });
  });

  test("成功时也保留最远失败信息", () => {
    const g = seq(alt(lit("ab"), lit("a")), lit("c"));
    const r = parse(g, "ac");
    assert.equal(r.ok, true);
    assert.deepEqual(r.failure, { pos: 0, expected: ['"ab"'] });
  });
});

describe("表达式语法（cut 用于报错）", () => {
  const num = re(/\d+/, "number");
  const expr: Parser = lazy(() =>
    alt(seq(term, lit("+"), cut, expr), term),
  );
  const term: Parser = lazy(() =>
    alt(seq(lit("("), cut, expr, lit(")")), num),
  );
  const top = seq(expr, eof);

  test("合法输入", () => {
    assert.equal(parse(top, "1+2+(3+4)").ok, true);
  });

  test("缺右括号：已提交失败并指向最远位置", () => {
    const { m, n } = both(top, "1+(2");
    assert.equal(m.ok, false);
    assert.equal(m.committed, true);
    assert.equal(m.failure.pos, 4);
    assert.ok(m.failure.expected.includes('")"'));
    assert.deepEqual(
      { ...m.failure, expected: [...m.failure.expected].sort() },
      { ...n.failure, expected: [...n.failure.expected].sort() },
    );
  });
});

describe("记忆化解释器 vs 无缓存解释器（随机对照）", () => {
  function makeRng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  const rand = (rng: () => number, n: number) => Math.floor(rng() * n);

  function genTerminal(rng: () => number): Parser {
    const len = 1 + rand(rng, 2);
    let s = "";
    for (let i = 0; i < len; i++) s += "abc"[rand(rng, 3)];
    return lit(s);
  }

  // 保证不可空，避免 rep 触发 GrammarError
  function genNonNullable(rng: () => number): Parser {
    const k = rng();
    if (k < 0.5) return genTerminal(rng);
    if (k < 0.75) return seq(genTerminal(rng), genTerminal(rng));
    return alt(genTerminal(rng), genTerminal(rng));
  }

  function genParser(rng: () => number, depth: number): Parser {
    if (depth <= 0) return genTerminal(rng);
    switch (rand(rng, 6)) {
      case 0:
        return genTerminal(rng);
      case 1:
        return seq(genParser(rng, depth - 1), genParser(rng, depth - 1));
      case 2:
        return seq(genParser(rng, depth - 1), cut, genParser(rng, depth - 1));
      case 3:
        return alt(genParser(rng, depth - 1), genParser(rng, depth - 1));
      case 4:
        return rep(genNonNullable(rng), rand(rng, 2));
      default:
        return opt(genParser(rng, depth - 1));
    }
  }

  function genInput(rng: () => number): string {
    const len = rand(rng, 7);
    let s = "";
    for (let i = 0; i < len; i++) s += "abc"[rand(rng, 3)];
    return s;
  }

  function normalize(o: ParseOutcome) {
    return {
      ok: o.ok,
      pos: o.pos,
      committed: o.committed,
      failure: { pos: o.failure.pos, expected: [...o.failure.expected].sort() },
    };
  }

  test("400 组随机语法×输入结果完全一致", () => {
    const rng = makeRng(20261005);
    for (let i = 0; i < 400; i++) {
      const g = genParser(rng, 3);
      const input = genInput(rng);
      const m = parse(g, input, { memo: true });
      const n = parse(g, input, { memo: false });
      assert.deepEqual(
        normalize(m),
        normalize(n),
        `case ${i}: input=${JSON.stringify(input)}`,
      );
      assert.ok(m.evals <= n.evals, `case ${i}: memo 不应比无缓存求值更多`);
    }
  });
});
