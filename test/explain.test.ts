import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AssertionFailure,
  MAX_INPUTS,
  MissingInputError,
  assertThat,
  explain,
  replayEvidence,
  type Evidence,
  type Inputs,
} from '../src/explain.ts';

test('断言依赖多个输入: 失败时返回最小原因切片', () => {
  const fn = (inputs: Inputs) => {
    const total = (inputs.price as number) * (inputs.qty as number);
    const budget = inputs.budget as number;
    assertThat(total <= budget, `over budget: ${total} > ${budget}`);
  };
  const evidence = explain('cart total', fn, {
    price: 30,
    qty: 4,
    budget: 100,
    userId: 'u-1',
    note: 'gift',
  });

  assert.equal(evidence.status, 'failure');
  assert.ok(evidence.reason);
  // userId / note 从未被读取, 不进入依赖切片
  assert.deepEqual([...evidence.accessedInputs].sort(), ['budget', 'price', 'qty']);
  // 最小原因切片包含全部三个相关输入
  assert.deepEqual(evidence.reason.inputs, { price: 30, qty: 4, budget: 100 });
  // 穷举移除验证: 移除任一剩余输入都无法复现失败
  assert.equal(evidence.reason.minimalityChecks.length, 3);
  assert.ok(evidence.reason.minimalityChecks.every((c) => !c.reproduced));
  // 可重放证据
  assert.equal(evidence.reason.replay.reproduced, true);
  assert.equal(evidence.reason.replay.message, 'over budget: 120 > 100');
  assert.ok(replayEvidence(fn, evidence));
});

test('条件未执行分支中的输入不计入来源', () => {
  const fn = (inputs: Inputs) => {
    if (inputs.useLegacy as boolean) {
      assertThat((inputs.legacyScore as number) > 0, 'legacy score too low');
    } else {
      assertThat((inputs.modernScore as number) > 0, 'modern score too low');
    }
  };
  const evidence = explain('branch', fn, {
    useLegacy: false,
    legacyScore: 0, // 未执行分支的输入
    modernScore: -1,
  });

  assert.equal(evidence.status, 'failure');
  // legacyScore 未被读取
  assert.ok(!evidence.accessedInputs.includes('legacyScore'));
  // 原因切片自包含: useLegacy 决定走哪条分支, modernScore 是失败值, 两者皆必要
  assert.deepEqual(evidence.reason!.inputs, { useLegacy: false, modernScore: -1 });
  assert.ok(evidence.reason!.minimalityChecks.every((c) => !c.reproduced));
  assert.ok(replayEvidence(fn, evidence));
});

test('读取缺失输入视为错误, 与断言失败区分', () => {
  const fn = (inputs: Inputs) => {
    assertThat((inputs.missing as number) > 0, 'unreachable');
  };
  const evidence = explain('missing input', fn, {});
  assert.equal(evidence.status, 'error');
  assert.match(evidence.error!.message, /^MissingInputError: input not provided: missing/);
  assert.equal(evidence.reason, undefined);
  assert.ok(new MissingInputError('k') instanceof Error);
});

test('错误与断言失败分开: 普通异常不产生原因切片', () => {
  const fn = (inputs: Inputs) => {
    const parsed = JSON.parse(inputs.payload as string);
    assertThat(parsed.ok === true, 'not ok');
  };
  const evidence = explain('parse error', fn, { payload: '{invalid' });

  assert.equal(evidence.status, 'error');
  assert.match(evidence.error!.message, /^SyntaxError/);
  assert.equal(evidence.reason, undefined);
  assert.equal(replayEvidence(fn, evidence), false);
});

test('显式抛出的非断言错误同样归类为 error', () => {
  const fn = () => {
    throw new TypeError('boom');
  };
  const evidence = explain('type error', fn, { a: 1 });
  assert.equal(evidence.status, 'error');
  assert.equal(evidence.error!.message, 'TypeError: boom');
  assert.equal(evidence.reason, undefined);
});

test('AssertionFailure 是断言失败的标记类型', () => {
  const err = new AssertionFailure('nope');
  assert.equal(err.name, 'AssertionFailure');
  assert.ok(err instanceof Error);
});

test('测试通过时状态为 pass 且无原因切片', () => {
  const fn = (inputs: Inputs) => {
    assertThat((inputs.x as number) > 0, 'x must be positive');
  };
  const evidence = explain('passing', fn, { x: 5, unused: true });
  assert.equal(evidence.status, 'pass');
  assert.deepEqual(evidence.accessedInputs, ['x']);
  assert.equal(evidence.reason, undefined);
  assert.equal(evidence.error, undefined);
});

test('超过 20 个输入时拒绝解释', () => {
  const inputs: Inputs = {};
  for (let i = 0; i < MAX_INPUTS + 1; i += 1) {
    inputs[`k${i}`] = i;
  }
  assert.throws(() => explain('too many', () => {}, inputs), /too many inputs: 21 > 20/);
});

test('恰好 20 个输入时仍可穷举移除验证', () => {
  const fn = (inputs: Inputs) => {
    assertThat((inputs.k0 as number) < 100, 'k0 too large');
  };
  const inputs: Inputs = {};
  for (let i = 0; i < MAX_INPUTS; i += 1) {
    inputs[`k${i}`] = i === 0 ? 500 : i;
  }
  const evidence = explain('twenty inputs', fn, inputs);
  assert.equal(evidence.status, 'failure');
  // 其余 19 个输入全部被穷举移除, 原因切片只剩 k0
  assert.deepEqual(evidence.reason!.inputs, { k0: 500 });
  assert.equal(evidence.reason!.removedInputs.length, 0); // k1..k19 从未被读取
  assert.deepEqual(evidence.reason!.minimalityChecks, [{ removed: 'k0', reproduced: false }]);
  assert.ok(replayEvidence(fn, evidence));
});

test('多输入共同作用: 切片保留全部必要输入', () => {
  // 只有 a 与 b 同时超限才失败: 两者都必要
  const fn = (inputs: Inputs) => {
    assertThat(!((inputs.a as number) > 10 && (inputs.b as number) > 10), 'a and b both too large');
  };
  const evidence = explain('joint cause', fn, { a: 20, b: 30, c: 99 });
  assert.equal(evidence.status, 'failure');
  assert.deepEqual(evidence.reason!.inputs, { a: 20, b: 30 });
  assert.ok(evidence.reason!.minimalityChecks.every((check) => !check.reproduced));
  assert.ok(replayEvidence(fn, evidence));
});

test('证据可序列化为 JSON 用于存档与重放', () => {
  const fn = (inputs: Inputs) => {
    assertThat((inputs.n as number) % 2 === 0, 'n must be even');
  };
  const evidence: Evidence = explain('json', fn, { n: 3, noise: 'x' });
  const revived = JSON.parse(JSON.stringify(evidence)) as Evidence;
  assert.equal(revived.status, 'failure');
  assert.deepEqual(revived.reason!.inputs, { n: 3 });
  assert.ok(replayEvidence(fn, revived));
});
