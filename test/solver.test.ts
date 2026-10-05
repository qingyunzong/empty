import test from "node:test";
import assert from "node:assert/strict";
import { buildCertificate, compareSeq, edgeFits, solve } from "../src/solver.js";
import { parseProblem } from "../src/parse.js";
import { Problem } from "../src/types.js";

function problem(partial: Partial<Problem>): Problem {
  return { start: "s", target: "t", spaceLimit: 1000, packages: [], ...partial };
}

test("compareSeq: 字典序与前缀规则", () => {
  assert.equal(compareSeq([], []), 0);
  assert.equal(compareSeq(["a"], ["a"]), 0);
  assert.ok(compareSeq(["a"], ["b"]) < 0);
  assert.ok(compareSeq(["b"], ["a"]) > 0);
  assert.ok(compareSeq(["a"], ["a", "b"]) < 0, "前缀更短者更小");
  assert.ok(compareSeq(["a", "z"], ["b"]) < 0, "首元素决定");
  assert.ok(compareSeq(["a", "b"], ["a", "c"]) < 0, "次元素决定");
});

test("edgeFits: bytes+peak 不超过上限才可行", () => {
  const pkg = { id: "p", from: "a", to: "b", bytes: 100, peak: 50 };
  assert.ok(edgeFits(pkg, 150));
  assert.ok(!edgeFits(pkg, 149));
});

test("求解: 选总下载量最小的路径", () => {
  const res = solve(
    problem({
      packages: [
        { id: "direct", from: "s", to: "t", bytes: 300, peak: 0 },
        { id: "h1", from: "s", to: "m", bytes: 100, peak: 0 },
        { id: "h2", from: "m", to: "t", bytes: 100, peak: 0 },
      ],
    })
  );
  assert.ok(res.ok);
  assert.equal(res.totalBytes, 200);
  assert.deepEqual(res.sequence, ["h1", "h2"]);
});

test("求解: 同费用时取包 ID 序列字典序最小", () => {
  const res = solve(
    problem({
      packages: [
        { id: "pkg-b", from: "s", to: "u", bytes: 60, peak: 0 },
        { id: "pkg-d", from: "u", to: "t", bytes: 40, peak: 0 },
        { id: "pkg-a", from: "s", to: "v", bytes: 60, peak: 0 },
        { id: "pkg-c", from: "v", to: "t", bytes: 40, peak: 0 },
      ],
    })
  );
  assert.ok(res.ok);
  assert.equal(res.totalBytes, 100);
  assert.deepEqual(res.sequence, ["pkg-a", "pkg-c"]);
});

test("求解: 字典序并列由后续元素决定", () => {
  const res = solve(
    problem({
      packages: [
        { id: "a", from: "s", to: "u", bytes: 50, peak: 0 },
        { id: "z", from: "u", to: "t", bytes: 50, peak: 0 },
        { id: "b", from: "u", to: "w", bytes: 20, peak: 0 },
        { id: "c", from: "w", to: "t", bytes: 30, peak: 0 },
      ],
    })
  );
  assert.ok(res.ok);
  assert.equal(res.totalBytes, 100);
  assert.deepEqual(res.sequence, ["a", "b", "c"], "[a,b,c] 字典序小于 [a,z]");
});

test("求解: 空间不足的单条边被排除", () => {
  const res = solve(
    problem({
      spaceLimit: 200,
      packages: [
        { id: "big", from: "s", to: "t", bytes: 150, peak: 80 }, // 需 230 > 200
        { id: "s1", from: "s", to: "m", bytes: 90, peak: 100 },
        { id: "s2", from: "m", to: "t", bytes: 90, peak: 100 },
      ],
    })
  );
  assert.ok(res.ok);
  assert.deepEqual(res.sequence, ["s1", "s2"]);
  assert.deepEqual(res.excluded, [{ id: "big", need: 230 }]);
});

test("求解: 全部路径不可行时报告原因", () => {
  const res = solve(
    problem({
      spaceLimit: 10,
      packages: [{ id: "p", from: "s", to: "t", bytes: 50, peak: 0 }],
    })
  );
  assert.ok(!res.ok);
  assert.match(res.reason ?? "", /不存在/);
});

test("求解: 起点即终点时为空方案", () => {
  const res = solve(problem({ start: "x", target: "x" }));
  assert.ok(res.ok);
  assert.equal(res.totalBytes, 0);
  assert.deepEqual(res.sequence, []);
});

test("证书: 下载/峰值/清理逐步核算", () => {
  const { steps, maxPeak, ok } = buildCertificate(
    [
      { id: "p1", from: "a", to: "b", bytes: 100, peak: 120 },
      { id: "p2", from: "b", to: "c", bytes: 80, peak: 50 },
    ],
    300
  );
  assert.ok(ok);
  assert.equal(steps.length, 2);
  const s1 = steps[0];
  assert.equal(s1?.storedAfterDownload, 100);
  assert.equal(s1?.peakDuringApply, 220);
  assert.equal(s1?.storedAfterCleanup, 0, "已消费包被删除");
  assert.equal(s1?.withinLimit, true);
  assert.equal(maxPeak, 220);
});

test("证书: 超限步骤被标记", () => {
  const { steps, ok } = buildCertificate(
    [{ id: "p1", from: "a", to: "b", bytes: 100, peak: 120 }],
    200
  );
  assert.ok(!ok);
  assert.equal(steps[0]?.withinLimit, false);
});

test("parseProblem: 拒绝超过 18 个包", () => {
  const packages = Array.from({ length: 19 }, (_, i) => ({
    id: `p${i}`,
    from: "a",
    to: "b",
    bytes: 1,
    peak: 0,
  }));
  assert.throws(
    () => parseProblem({ start: "a", target: "b", spaceLimit: 10, packages }),
    /至多 18/
  );
});

test("parseProblem: 拒绝重复 ID / 非正 bytes / 缺字段", () => {
  const base = { start: "a", target: "b", spaceLimit: 10 };
  assert.throws(() =>
    parseProblem({
      ...base,
      packages: [
        { id: "p", from: "a", to: "b", bytes: 1, peak: 0 },
        { id: "p", from: "a", to: "b", bytes: 1, peak: 0 },
      ],
    })
  );
  assert.throws(() =>
    parseProblem({ ...base, packages: [{ id: "p", from: "a", to: "b", bytes: 0, peak: 0 }] })
  );
  assert.throws(() => parseProblem({ target: "b", spaceLimit: 10, packages: [] }));
});
