import { test } from "node:test";
import assert from "node:assert/strict";
import { merge, type Branch, type Edit, type MergeResult } from "../src/merge.js";

// ---------- 具体规则单测 ----------

test("不相交的编辑两边都可合并", () => {
  const r = merge("hello world", {
    id: "a",
    edits: [{ start: 0, end: 0, text: ">> " }],
  }, {
    id: "b",
    edits: [{ start: 6, end: 11, text: "there" }],
  });
  assert.equal(r.text, ">> hello there");
  assert.equal(r.conflicts.length, 0);
});

test("同点插入两边都保留，按分支 ID 排序，与传参顺序无关", () => {
  const a: Branch = { id: "alpha", edits: [{ start: 3, end: 3, text: "X" }] };
  const b: Branch = { id: "beta", edits: [{ start: 3, end: 3, text: "Y" }] };
  const r1 = merge("abcd", a, b);
  const r2 = merge("abcd", b, a); // 交换传参顺序
  assert.equal(r1.text, "abcXYd"); // alpha 的 X 在前
  assert.equal(r2.text, "abcXYd");
  assert.equal(r1.conflicts.length, 0);
});

test("两边完全相同的编辑只应用一次", () => {
  const e: Edit = { start: 1, end: 3, text: "ZZ" };
  const r = merge("abcd", { id: "a", edits: [e] }, { id: "b", edits: [e] });
  assert.equal(r.text, "aZZd");
  assert.equal(r.conflicts.length, 0);
});

test("重叠且不同的编辑产生冲突，取分支 ID 较小一方", () => {
  const r = merge("abcdef", {
    id: "b",
    edits: [{ start: 1, end: 4, text: "BBB" }],
  }, {
    id: "a",
    edits: [{ start: 2, end: 5, text: "AA" }],
  });
  assert.equal(r.conflicts.length, 1);
  const c = r.conflicts[0]!;
  assert.equal(c.winner, "a");
  assert.equal(c.start, 1);
  assert.equal(c.end, 5);
  // 冲突区间取并集 [1,5)，双方效果各自包含未被覆盖的原文部分
  assert.equal(c.lowText, "bAA");
  assert.equal(c.highText, "BBBe");
  assert.equal(r.text, "abAAf"); // 采用 a 分支
});

test("删除区间包含另一方的修改 → 冲突；边界插入不冲突", () => {
  // 删除 [1,4) vs 修改 [2,3)
  const r1 = merge("abcde", { id: "a", edits: [{ start: 1, end: 4, text: "" }] }, {
    id: "b",
    edits: [{ start: 2, end: 3, text: "X" }],
  });
  assert.equal(r1.conflicts.length, 1);

  // 删除 [1,4) vs 严格内部插入点 2
  const r2 = merge("abcde", { id: "a", edits: [{ start: 1, end: 4, text: "" }] }, {
    id: "b",
    edits: [{ start: 2, end: 2, text: "X" }],
  });
  assert.equal(r2.conflicts.length, 1);

  // 删除 [1,4) vs 边界插入点 1 和 4：不冲突
  const r3 = merge("abcde", { id: "a", edits: [{ start: 1, end: 4, text: "" }] }, {
    id: "b",
    edits: [
      { start: 1, end: 1, text: "L" },
      { start: 4, end: 4, text: "R" },
    ],
  });
  assert.equal(r3.conflicts.length, 0);
  assert.equal(r3.text, "aLRe"); // 删除 bcd，边界插入 L（删区前）与 R（删区后）
});

test("双向位置映射的具体取值", () => {
  //            0123456789
  const r = merge("abcdefghij", {
    id: "a",
    edits: [{ start: 2, end: 4, text: "XYZ" }], // cd -> XYZ
  }, {
    id: "b",
    edits: [{ start: 8, end: 10, text: "" }], // 删除 ij
  });
  assert.equal(r.text, "abXYZefgh");
  const m = r.map;
  // 保留区线性映射
  assert.equal(m.origToMerged(0), 0);
  assert.equal(m.origToMerged(2), 2);
  assert.equal(m.origToMerged(4), 5); // 替换区右边界 -> 替换文本末尾
  assert.equal(m.origToMerged(5), 6);
  // 被替换区间内部 -> 替换文本起点
  assert.equal(m.origToMerged(3), 2);
  // 被删除区间 [8,10) -> 合并位置 9（"abXYZefgh" 的末尾）
  assert.equal(m.origToMerged(9), 9);
  // 末尾固定映射
  assert.equal(m.origToMerged(10), 9);
  // 反向
  assert.equal(m.mergedToOrig(0), 0);
  assert.equal(m.mergedToOrig(2), 2); // 替换文本起点 -> 原区间起点
  assert.equal(m.mergedToOrig(3), 2); // 插入文本内部 -> 原区间起点
  assert.equal(m.mergedToOrig(5), 4); // 替换文本末尾 -> 原区间末尾
  assert.equal(m.mergedToOrig(6), 5);
  assert.equal(m.mergedToOrig(9), 10);
});

// ---------- 短字符串全区间枚举核对 ----------

interface TaggedEdit extends Edit {
  branch: string;
}

/** 独立参考实现：倒序 splice 应用全部编辑（仅在编辑互不交互时有效）。 */
function oracleApply(original: string, edits: TaggedEdit[]): string {
  const sorted = [...edits].sort((x, y) =>
    y.start - x.start ||
    y.end - x.end ||
    (x.branch < y.branch ? 1 : x.branch > y.branch ? -1 : 0));
  let out = original;
  for (const e of sorted) {
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
  }
  return out;
}

/** 两个编辑是否交互（与库内规则对应的独立表述）。 */
function pairInteracts(x: Edit, y: Edit): boolean {
  const xIns = x.start === x.end;
  const yIns = y.start === y.end;
  if (xIns && yIns) return x.start === y.start;
  if (xIns) return y.start < x.start && x.start < y.end;
  if (yIns) return x.start < y.start && y.start < x.end;
  return x.start < y.end && y.start < x.end;
}

function editsKey(e: Edit): string {
  return `${e.start},${e.end},${e.text}`;
}

/** 通用不变量：段重建、连续性、映射单调性与往返一致。 */
function checkInvariants(original: string, r: MergeResult): void {
  let rebuilt = "";
  for (const seg of r.segments) {
    rebuilt += seg.kind === "keep" ? original.slice(seg.origStart, seg.origEnd) : seg.text;
  }
  assert.equal(rebuilt, r.text, "segments rebuild text");

  let mo = 0;
  let mm = 0;
  for (const seg of r.segments) {
    assert.equal(seg.origStart, mo, "segments contiguous in orig");
    assert.equal(seg.mergedStart, mm, "segments contiguous in merged");
    mo = seg.origEnd;
    mm = seg.mergedStart + (seg.kind === "keep" ? seg.origEnd - seg.origStart : seg.text.length);
  }
  assert.equal(mo, original.length);
  assert.equal(mm, r.text.length);

  const m = r.map;
  assert.equal(m.origToMerged(original.length), r.text.length, "orig end -> merged end");
  assert.equal(m.mergedToOrig(r.text.length), original.length, "merged end -> orig end");

  let prevQ = 0;
  for (let p = 0; p <= original.length; p++) {
    const q = m.origToMerged(p);
    assert.ok(q >= prevQ && q <= r.text.length, `origToMerged monotone at ${p}`);
    prevQ = q;
    // 豁免：被替换/删除区间内部；以及删除（空替换文本）区间的左边界——
    // 删除未在合并结果中留下独立位置，反向映射会落到区间右边界。
    const ambiguous = r.segments.some(
      (s) => s.kind === "replace" &&
        ((s.origStart < p && p < s.origEnd) ||
          (s.text === "" && p === s.origStart && s.origStart < s.origEnd)));
    if (!ambiguous) {
      assert.equal(m.mergedToOrig(q), p, `round trip orig ${p}`);
    }
  }
  let prevP = 0;
  for (let q = 0; q <= r.text.length; q++) {
    const p = m.mergedToOrig(q);
    assert.ok(p >= prevP && p <= original.length, `mergedToOrig monotone at ${q}`);
    prevP = p;
    const insertedInterior = r.segments.some(
      (s) => s.kind === "replace" && s.mergedStart <= q && q < s.mergedStart + s.text.length);
    if (!insertedInterior) {
      assert.equal(m.origToMerged(p), q, `round trip merged ${q}`);
    }
  }
}

function* allStrings(alphabet: string[], maxLen: number): Generator<string> {
  for (let len = 0; len <= maxLen; len++) {
    const total = alphabet.length ** len;
    for (let k = 0; k < total; k++) {
      let s = "";
      let v = k;
      for (let i = 0; i < len; i++) {
        s = alphabet[v % alphabet.length] + s;
        v = Math.floor(v / alphabet.length);
      }
      yield s;
    }
  }
}

function* allEdits(n: number, texts: string[]): Generator<Edit> {
  for (let s = 0; s <= n; s++) {
    for (let e = s; e <= n; e++) {
      for (const t of texts) yield { start: s, end: e, text: t };
    }
  }
}

test("枚举：短字符串 × 全部单编辑区间对", (t) => {
  const texts = ["", "X", "YZ"];
  let count = 0;
  for (const original of allStrings(["a", "b"], 4)) {
    const edits = [...allEdits(original.length, texts)];
    for (const e1 of edits) {
      for (const e2 of edits) {
        const r = merge(original, { id: "a", edits: [e1] }, { id: "b", edits: [e2] });
        checkInvariants(original, r);
        const t1: TaggedEdit = { ...e1, branch: "a" };
        const t2: TaggedEdit = { ...e2, branch: "b" };
        if (!pairInteracts(e1, e2)) {
          // 不相交：无冲突，两边都应用
          assert.equal(r.conflicts.length, 0);
          assert.equal(r.text, oracleApply(original, [t1, t2]));
        } else if (e1.start === e1.end && e1.start === e2.start && e2.start === e2.end) {
          // 同点插入：无冲突，两边都应用（内容相同则去重为一次）
          assert.equal(r.conflicts.length, 0);
          const dedup = editsKey(e1) === editsKey(e2) ? [t1] : [t1, t2];
          assert.equal(r.text, oracleApply(original, dedup));
        } else {
          // 相交：比较双方在并集区间上的效果
          const cs = Math.min(e1.start, e2.start);
          const ce = Math.max(e1.end, e2.end);
          const lowEffect = original.slice(cs, e1.start) + e1.text + original.slice(e1.end, ce);
          const highEffect = original.slice(cs, e2.start) + e2.text + original.slice(e2.end, ce);
          if (lowEffect === highEffect) {
            // 效果相同（如重叠删除同一批字符）：应用一次，无冲突
            assert.equal(r.conflicts.length, 0);
            assert.equal(r.text, oracleApply(original, [t1]));
          } else {
            // 效果不同：恰好一个冲突，采用分支 a（ID 较小）
            assert.equal(r.conflicts.length, 1);
            const c = r.conflicts[0]!;
            assert.equal(c.start, cs);
            assert.equal(c.end, ce);
            assert.equal(c.winner, "a");
            assert.equal(c.lowText, lowEffect);
            assert.equal(c.highText, highEffect);
            assert.equal(c.resolvedText, lowEffect);
            assert.equal(r.text, oracleApply(original, [t1]));
          }
        }
        count++;
      }
    }
  }
  t.diagnostic(`scenarios: ${count}`);
  assert.ok(count > 40000, `expected >40000 scenarios, got ${count}`);
});

test("枚举：短字符串 × 每分支两个编辑", (t) => {
  const texts = ["", "X"];
  let count = 0;
  for (const original of allStrings(["a", "b"], 2)) {
    const edits = [...allEdits(original.length, texts)];
    // 构造合法（内部不重叠）的两编辑列表
    const lists: Edit[][] = [];
    for (const e1 of edits) {
      for (const e2 of edits) {
        const pair = [e1, e2].sort((x, y) => x.start - y.start || x.end - y.end);
        const [p, c] = pair as [Edit, Edit];
        const overlap = c.start < p.end ||
          (c.start === p.end && p.start === p.end && c.start === c.end);
        if (!overlap) lists.push(pair);
      }
    }
    for (const la of lists) {
      for (const lb of lists) {
        const r = merge(original, { id: "a", edits: la }, { id: "b", edits: lb });
        checkInvariants(original, r);
        const anyInteract = la.some((x) => lb.some((y) => pairInteracts(x, y)));
        if (!anyInteract) {
          assert.equal(r.conflicts.length, 0);
          const tagged: TaggedEdit[] = [
            ...la.map((e) => ({ ...e, branch: "a" })),
            ...lb.map((e) => ({ ...e, branch: "b" })),
          ];
          const seen = new Set<string>();
          const dedup = tagged.filter((e) => {
            const k = editsKey(e);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          assert.equal(r.text, oracleApply(original, dedup));
        }
        count++;
      }
    }
  }
  t.diagnostic(`scenarios: ${count}`);
  assert.ok(count > 5000, `expected >5000 scenarios, got ${count}`);
});
