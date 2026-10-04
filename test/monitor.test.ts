import { test } from 'node:test';
import {
  deepStrictEqual,
  strictEqual,
  ok,
  throws,
} from 'node:assert/strict';
import {
  compile,
  Monitor,
  type Evidence,
  type ConditionSpec,
} from '../src/monitor';

const spec: ConditionSpec = {
  name: 'A后3内B且无C',
  trigger: 'A',
  expect: 'B',
  forbid: ['C'],
  window: 3,
};

test('匹配：窗口内 B 到达，输出匹配证据（含 latency）', () => {
  const m = compile(spec);
  m.input('A');
  m.endTick();
  m.endTick();
  m.input('B');
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 2, latency: 2 },
  ]);
});

test('同 tick 输入先于超时：B 恰在 deadline 当 tick 到达仍匹配', () => {
  const m = compile(spec); // window=3, A@0 -> deadline=3
  m.input('A');
  m.endTick(3); // tick 3
  m.input('B'); // deadline 当 tick 的输入，应先于超时判定
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 3, latency: 3 },
  ]);
});

test('同 tick 输入先于超时：A 与 B 同 tick，latency 为 0', () => {
  const m = compile(spec);
  m.input('A');
  m.input('B');
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 0, latency: 0 },
  ]);
});

test('违例：超时，证据含 deadline 与 detectedTick', () => {
  const m = compile(spec);
  m.input('A');
  m.endTick(4); // 经过 deadline=3 的 endTick
  deepStrictEqual(m.getOutcomes(), [
    {
      kind: 'violation',
      reason: 'timeout',
      instanceId: 1,
      triggerTick: 0,
      deadline: 3,
      detectedTick: 3,
    },
  ]);
});

test('违例：窗口内出现 C，证据含禁止事件 payload；之后 B 不再匹配', () => {
  const m = compile(spec);
  m.input('A');
  m.endTick();
  m.input('C', { code: 42 });
  m.input('B'); // 实例已违例，B 无活跃实例可匹配
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    {
      kind: 'violation',
      reason: 'forbidden',
      instanceId: 1,
      triggerTick: 0,
      forbiddenEvent: { tick: 1, type: 'C', payload: { code: 42 } },
    },
  ]);
});

test('多个 A 各有实例：B 默认只满足最老实例，另一个独立超时', () => {
  const m = compile(spec);
  m.input('A'); // id=1, deadline=3
  m.endTick();
  m.input('A'); // id=2, deadline=4
  m.endTick();
  m.input('B'); // 匹配 id=1
  m.endTick(3); // id=2 在 tick 4 超时
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 2, latency: 2 },
    {
      kind: 'violation',
      reason: 'timeout',
      instanceId: 2,
      triggerTick: 1,
      deadline: 4,
      detectedTick: 4,
    },
  ]);
});

test('matchPolicy=all：一个 B 满足全部活跃实例', () => {
  const m = compile(spec, { matchPolicy: 'all' });
  m.input('A');
  m.input('A');
  m.input('B');
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 0, latency: 0 },
    { kind: 'match', instanceId: 2, triggerTick: 0, matchedTick: 0, latency: 0 },
  ]);
});

test('取消只销对应 ID：其余实例照常运行，被取消者无证据', () => {
  const m = compile(spec);
  m.input('A'); // id=1
  m.input('A'); // id=2
  strictEqual(m.cancel(1), true);
  strictEqual(m.cancel(1), false); // 已注销，重复取消失败
  strictEqual(m.cancel(999), false); // 不存在的 ID
  m.endTick();
  m.input('B'); // 只剩 id=2 可匹配
  m.endTick();
  deepStrictEqual(m.getOutcomes(), [
    { kind: 'match', instanceId: 2, triggerTick: 0, matchedTick: 1, latency: 1 },
  ]);
  deepStrictEqual(m.getTrace()[0]!.cancelled, [1]);
});

test('逐 tick 实例枚举：trace 记录输入、证据与活跃集合', () => {
  const m = compile(spec);
  m.input('A'); // tick 0
  m.endTick();
  m.input('A'); // tick 1
  m.endTick();
  m.input('B'); // tick 2，匹配最老 id=1
  m.endTick();
  const trace = m.getTrace();
  deepStrictEqual(
    trace.map((r) => ({ tick: r.tick, active: r.activeAfter })),
    [
      { tick: 0, active: [{ id: 1, triggerTick: 0, deadline: 3, remaining: 3 }] },
      {
        tick: 1,
        active: [
          { id: 1, triggerTick: 0, deadline: 3, remaining: 2 },
          { id: 2, triggerTick: 1, deadline: 4, remaining: 3 },
        ],
      },
      { tick: 2, active: [{ id: 2, triggerTick: 1, deadline: 4, remaining: 2 }] },
    ],
  );
  deepStrictEqual(trace[2]!.evidence, [
    { kind: 'match', instanceId: 1, triggerTick: 0, matchedTick: 2, latency: 2 },
  ]);
});

/** 一段混合场景脚本，用于快照续行对照 */
function runScript(m: Monitor, fromPhase: number): void {
  const phases: Array<() => void> = [
    () => { m.input('A'); m.endTick(); },                    // phase 0 -> tick 1
    () => { m.input('A'); m.input('X'); m.endTick(); },      // phase 1 -> tick 2
    () => { m.input('B'); m.endTick(); },                    // phase 2 -> tick 3
    () => { m.input('C'); m.endTick(); },                    // phase 3 -> tick 4
    () => { m.endTick(3); },                                 // phase 4 -> tick 7
  ];
  for (let i = fromPhase; i < phases.length; i++) phases[i]!();
}

test('快照续行：恢复后运行结果与不中断运行完全一致', () => {
  const full = compile(spec);
  runScript(full, 0);

  // 在 tick 2 留一个未 endTick 的 pending 输入后快照，再恢复续行
  const pre = compile(spec);
  pre.input('A'); pre.endTick();          // tick 1
  pre.input('A'); pre.input('X'); pre.endTick(); // tick 2
  pre.input('B');                          // tick 2 的 pending 输入，未 endTick
  const restored = Monitor.restoreJSON(pre.snapshotJSON());
  restored.endTick();                      // tick 3
  restored.input('C'); restored.endTick(); // tick 4
  restored.endTick(3);                     // tick 7

  deepStrictEqual(restored.getOutcomes(), full.getOutcomes());
  deepStrictEqual(restored.getTrace(), full.getTrace());
  deepStrictEqual(restored.getActive(), full.getActive());
  strictEqual(restored.tick, full.tick);
});

test('快照：恢复后 ID 计数延续，不产生冲突', () => {
  const m = compile(spec);
  m.input('A'); // id=1
  m.endTick();
  const restored = Monitor.restore(m.snapshot());
  restored.input('A'); // 应为 id=2
  strictEqual(restored.getActive()[0]!.id, 1);
  strictEqual(restored.getActive()[1]!.id, 2);
});

test('无活跃实例时 B 被忽略，不产生证据', () => {
  const m = compile(spec);
  m.input('B');
  m.endTick();
  deepStrictEqual(m.getOutcomes(), []);
});

test('非法条件与非法快照被拒绝', () => {
  throws(() => compile({ trigger: 'A', expect: 'B', window: -1 }));
  throws(() => compile({ trigger: '', expect: 'B', window: 1 }));
  throws(() => Monitor.restore({ version: 2 } as never));
  const m = compile(spec);
  throws(() => m.endTick(0));
});

test('证据对象不被外部修改影响（防御性拷贝）', () => {
  const m = compile(spec);
  m.input('A');
  m.input('B');
  m.endTick();
  const outcomes = m.getOutcomes() as unknown as Array<Record<string, unknown>>;
  outcomes[0]!['latency'] = 999;
  strictEqual((m.getOutcomes()[0] as Evidence & { latency: number }).latency, 0);
});
