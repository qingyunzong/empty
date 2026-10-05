import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RankingTable, Standing } from '../src/ranking';

function orderOf(standings: Standing[]): string[] {
  return standings.map((s) => s.teamId);
}

function tableOf(...teamIds: string[]): RankingTable {
  const t = new RankingTable();
  for (const id of teamIds) t.addTeam(id);
  return t;
}

test('基本积分：胜3 平1 负0，按积分排名', () => {
  const t = tableOf('A', 'B', 'C', 'D');
  t.addResult('m1', 'A', 'B', 2, 1); // A 胜
  t.addResult('m2', 'C', 'D', 1, 1); // 平
  t.addResult('m3', 'A', 'C', 0, 2); // C 胜
  const s = t.getStandings();
  assert.deepEqual(orderOf(s), ['C', 'A', 'D', 'B']);
  assert.deepEqual(
    s.map((x) => x.points),
    [4, 3, 1, 0],
  );
  assert.deepEqual(
    s.map((x) => x.rank),
    [1, 2, 3, 4],
  );
  const c = s[0]!;
  assert.equal(c.played, 2);
  assert.equal(c.won, 1);
  assert.equal(c.drawn, 1);
  assert.equal(c.pointsFor, 3);
  assert.equal(c.pointsAgainst, 1);
  assert.equal(c.diff, 2);
});

test('同分：相互战绩优先于总净胜分', () => {
  const t = tableOf('A', 'B', 'C');
  t.addResult('m1', 'A', 'B', 1, 0); // A 胜 B
  t.addResult('m2', 'B', 'C', 5, 0); // B 大胜 C，总净胜分 B(+4) > A(+1)
  const s = t.getStandings();
  // A、B 同积 3 分；按相互战绩 A 应排在 B 前，尽管总净胜分更差
  assert.deepEqual(orderOf(s), ['A', 'B', 'C']);
});

test('同分：小联赛净胜分（两回合相互战绩积分相同）', () => {
  const t = tableOf('A', 'B', 'C');
  t.addResult('m1', 'A', 'B', 2, 0); // 首回合 A 2-0
  t.addResult('m2', 'B', 'A', 1, 0); // 次回合 B 1-0
  t.addResult('m3', 'A', 'C', 1, 0);
  t.addResult('m4', 'B', 'C', 1, 0);
  // A、B 同积 6 分；小联赛各 3 分，小联赛净胜分 A(+1) > B(-1)
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B', 'C']);
});

test('同分：连环平局递归无进展时按 ID', () => {
  const t = tableOf('A', 'B', 'C');
  t.addResult('m1', 'A', 'B', 1, 0);
  t.addResult('m2', 'B', 'C', 1, 0);
  t.addResult('m3', 'C', 'A', 1, 0);
  // 三队同积 3 分，小联赛积分、净胜分完全相同 -> 无进展 -> 按 ID
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B', 'C']);
});

test('同分：递归平局——子组按同一规则再分（相互比赛决定）', () => {
  // A/B/C 同积 6 分。小联赛（不含 D）：A 3分/-2，B 3分/+1，C 3分/+1。
  // {B,C} 子组递归：相互比赛 B 3-1 胜 C -> B 在 C 前。
  const t = tableOf('A', 'B', 'C', 'D');
  t.addResult('m1', 'A', 'B', 1, 0);
  t.addResult('m2', 'C', 'A', 3, 0);
  t.addResult('m3', 'B', 'C', 3, 1);
  t.addResult('m4', 'A', 'D', 1, 0);
  t.addResult('m5', 'B', 'D', 1, 0);
  t.addResult('m6', 'C', 'D', 1, 0);
  const s = t.getStandings();
  assert.deepEqual(orderOf(s), ['B', 'C', 'A', 'D']);
  assert.deepEqual(
    s.map((x) => x.points),
    [6, 6, 6, 0],
  );
});

test('取消场次：回滚积分并重算受影响名次', () => {
  const t = tableOf('A', 'B', 'C');
  t.addResult('m1', 'A', 'B', 1, 0);
  t.addResult('m2', 'B', 'C', 1, 0);
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B', 'C']);
  const affected = t.cancelMatch('m1');
  // 取消后 B 3 分第一；A、C 同积 0 分且无相互比赛 -> 按 ID
  assert.deepEqual(orderOf(t.getStandings()), ['B', 'A', 'C']);
  // 受影响重算的名次应包含三支队伍（A 旧3新0、B 3 分，C 与 A 同积 0 分）
  assert.deepEqual([...affected].sort(), ['A', 'B', 'C']);
  t.assertConsistent();
});

test('取消未比赛的场次不影响名次', () => {
  const t = tableOf('A', 'B');
  t.addResult('m1', 'A', 'B', 1, 0);
  t.scheduleMatch('m2', 'B', 'A');
  const affected = t.cancelMatch('m2');
  assert.deepEqual(affected, []);
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B']);
  t.assertConsistent();
});

test('更正结果：胜负反转后重算名次', () => {
  const t = tableOf('A', 'B', 'C', 'D');
  t.addResult('m1', 'A', 'B', 1, 0);
  t.addResult('m2', 'C', 'D', 1, 0);
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'C', 'B', 'D']);
  const affected = t.correctResult('m1', 0, 2); // 改为 B 胜
  assert.deepEqual(orderOf(t.getStandings()), ['B', 'C', 'A', 'D']);
  assert.deepEqual([...affected].sort(), ['A', 'B', 'C', 'D']);
  t.assertConsistent();
});

test('更正结果：只改比分不改胜负时仍重算同分组', () => {
  const t = tableOf('A', 'B', 'C');
  t.addResult('m1', 'A', 'C', 1, 0);
  t.addResult('m2', 'B', 'C', 2, 0);
  // A、B 同积 3 分，无相互比赛 -> 按 ID：A 前 B 后
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B', 'C']);
  t.correctResult('m2', 5, 0); // B 仍胜，积分不变
  assert.deepEqual(orderOf(t.getStandings()), ['A', 'B', 'C']);
  t.assertConsistent();
});

test('脚本化事件序列：每步与完整重算核对', () => {
  const t = tableOf('A', 'B', 'C', 'D', 'E');
  const step = () => {
    t.assertConsistent();
    assert.deepEqual(t.getStandings(), t.fullRecompute());
  };
  t.addResult('m1', 'A', 'B', 2, 0);
  t.addResult('m2', 'C', 'D', 1, 1);
  t.addResult('m3', 'E', 'A', 0, 0);
  t.addResult('m4', 'B', 'C', 3, 3);
  step();
  t.correctResult('m1', 0, 1); // A 胜 -> B 胜
  step();
  t.cancelMatch('m4'); // 取消平局
  step();
  t.addResult('m5', 'D', 'E', 2, 2);
  t.correctResult('m2', 2, 1); // 平 -> C 胜
  step();
  t.cancelMatch('m2'); // 再取消
  step();
  t.correctResult('m5', 1, 0); // 平 -> D 胜
  step();
});

test('非法操作抛出异常', () => {
  const t = tableOf('A', 'B');
  t.scheduleMatch('m1', 'A', 'B');
  assert.throws(() => t.correctResult('m1', 1, 0)); // 未比赛不能更正
  t.recordResult('m1', 1, 0);
  assert.throws(() => t.recordResult('m1', 2, 0)); // 已比赛不能重复录入
  t.cancelMatch('m1');
  assert.throws(() => t.cancelMatch('m1')); // 不能重复取消
  assert.throws(() => t.correctResult('m1', 1, 1)); // 已取消不能更正
  assert.throws(() => t.addTeam('A')); // 重复队伍
  assert.throws(() => t.scheduleMatch('m2', 'A', 'X')); // 未知队伍
  assert.throws(() => t.scheduleMatch('m2', 'A', 'A')); // 自己对自己
  assert.throws(() => t.recordResult('nope', 1, 0)); // 未知场次
});

// ---- 随机模糊测试：任意事件序列后，增量结果必须等于完整重算 ----

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

test('模糊测试：随机事件序列下增量名次与完整重算一致', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const rand = mulberry32(seed);
    const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
    const teams = Array.from({ length: 12 }, (_, i) => `T${i}`);
    const t = new RankingTable();
    for (const id of teams) t.addTeam(id);

    let matchSeq = 0;
    const scheduled: string[] = [];
    const played: string[] = [];
    const live: string[] = [];

    for (let op = 0; op < 300; op++) {
      const before = new Map(t.getStandings().map((s) => [s.teamId, s.rank]));
      let affected: string[] = [];
      const roll = rand();
      if (roll < 0.4 || (scheduled.length === 0 && played.length === 0)) {
        const home = pick(teams);
        let away = pick(teams);
        while (away === home) away = pick(teams);
        const id = `m${matchSeq++}`;
        t.scheduleMatch(id, home, away);
        scheduled.push(id);
        live.push(id);
      } else if (roll < 0.7 && scheduled.length > 0) {
        const id = scheduled.splice(Math.floor(rand() * scheduled.length), 1)[0]!;
        affected = t.recordResult(id, Math.floor(rand() * 5), Math.floor(rand() * 5));
        played.push(id);
      } else if (roll < 0.85 && played.length > 0) {
        const id = pick(played);
        affected = t.correctResult(id, Math.floor(rand() * 5), Math.floor(rand() * 5));
      } else if (live.length > 0) {
        const id = live.splice(Math.floor(rand() * live.length), 1)[0]!;
        affected = t.cancelMatch(id);
        const si = scheduled.indexOf(id);
        if (si >= 0) scheduled.splice(si, 1);
        const pi = played.indexOf(id);
        if (pi >= 0) played.splice(pi, 1);
      } else {
        continue;
      }

      // 每次事件后：增量名次必须与完整重算完全一致
      assert.deepEqual(t.getStandings(), t.fullRecompute(), `seed=${seed} op=${op}`);

      // 未受影响队伍之间的相对顺序必须保持不变
      // （即新名次中非受影响队伍的序列是旧序列的子序列）
      const affectedSet = new Set(affected);
      const beforeOrder = [...before.keys()].filter((id) => !affectedSet.has(id));
      const afterOrder = t
        .getStandings()
        .map((s) => s.teamId)
        .filter((id) => !affectedSet.has(id));
      let cursor = 0;
      for (const id of afterOrder) {
        while (cursor < beforeOrder.length && beforeOrder[cursor] !== id) cursor++;
        assert.ok(cursor < beforeOrder.length, `seed=${seed} op=${op} team=${id} relative order changed without recompute`);
        cursor++;
      }
    }
    t.assertConsistent();
    // 名次应为 1..N 的排列
    assert.deepEqual(
      t.getStandings().map((s) => s.rank),
      teams.map((_, i) => i + 1),
    );
  }
});
