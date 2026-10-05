import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { validateInput, type PlanInput } from '../src/model.js';
import { solve } from '../src/solve.js';
import { bruteForce, solutionsAgree, bruteForceCombinations } from '../src/brute.js';
import { buildCertificate, verifyCertificate } from '../src/certificate.js';
import { generateSample } from '../src/sample.js';
import { seededRng, randInt } from '../src/util.js';

/** 生成随机小实例（收益表允许任意非线性、非单调）。 */
function randomInput(rng: () => number): PlanInput {
  const numChannels = randInt(rng, 1, 3);
  const channels = Array.from({ length: numChannels }, (_, i) => ({
    id: `c${i}`,
    budget: randInt(rng, 0, 25),
  }));
  const numGroups = randInt(rng, 1, 5);
  const groups = Array.from({ length: numChannels === 0 ? 0 : numGroups }, (_, i) => ({
    id: `g${i}`,
    channel: channels[randInt(rng, 0, numChannels - 1)].id,
    unitCost: randInt(rng, 0, 5),
    unitExposure: randInt(rng, 0, 4),
    revenue: [0, ...Array.from({ length: 10 }, () => randInt(rng, 0, 60))],
  }));
  return { channels, exposureLowerBound: randInt(rng, 0, 30), groups };
}

test('DP 与穷举在 120 个随机小实例上结论一致', () => {
  const rng = seededRng(42);
  let feasible = 0;
  let infeasible = 0;
  for (let t = 0; t < 120; t++) {
    const input = randomInput(rng);
    const dp = solve(input);
    const bf = bruteForce(input);
    assert.ok(
      solutionsAgree(dp, bf),
      `实例 ${t} 不一致: DP=${dp.status}/${dp.totalRevenue}/${dp.totalCost} BF=${bf.status}/${bf.totalRevenue}/${bf.totalCost}`,
    );
    if (dp.status === 'optimal') feasible++;
    else infeasible++;
  }
  assert.ok(feasible > 0 && infeasible > 0, `样例应同时覆盖可行与不可行（可行 ${feasible}，不可行 ${infeasible}）`);
});

test('收益并列时选择成本最低的方案', () => {
  const input = validateInput({
    channels: [{ id: 'c', budget: 2 }],
    exposureLowerBound: 0,
    groups: [
      { id: 'A', channel: 'c', unitCost: 2, unitExposure: 0, revenue: [0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] },
      { id: 'B', channel: 'c', unitCost: 1, unitExposure: 0, revenue: [0, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10] },
    ],
  });
  const s = solve(input);
  assert.equal(s.status, 'optimal');
  assert.equal(s.totalRevenue, 10);
  assert.equal(s.totalCost, 1); // B 投 1 单位，而非 A 投 1 单位（成本 2）
  assert.deepEqual(s.quantities, [0, 1]);
});

test('分渠道预算各自独立生效', () => {
  const input = validateInput({
    channels: [
      { id: 'x', budget: 3 },
      { id: 'y', budget: 0 },
    ],
    exposureLowerBound: 0,
    groups: [
      { id: 'A', channel: 'x', unitCost: 1, unitExposure: 0, revenue: [0, 5, 9, 12, 14, 15, 16, 17, 18, 19, 20] },
      { id: 'B', channel: 'y', unitCost: 1, unitExposure: 0, revenue: [0, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100] },
    ],
  });
  const s = solve(input);
  assert.equal(s.totalRevenue, 12); // y 渠道预算为 0，B 无法投放；A 投 3 单位
  assert.equal(s.channelSpend.x, 3);
  assert.equal(s.channelSpend.y, 0);
});

test('曝光下限不可达时报告不可行', () => {
  const input = validateInput({
    channels: [{ id: 'c', budget: 100 }],
    exposureLowerBound: 5,
    groups: [{ id: 'A', channel: 'c', unitCost: 1, unitExposure: 0, revenue: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] }],
  });
  const s = solve(input);
  assert.equal(s.status, 'infeasible');
  const bf = bruteForce(input);
  assert.equal(bf.status, 'infeasible');
});

test('非线性（非单调）收益表被精确处理', () => {
  // revenue[2] 低于 revenue[1]，贪心和单调假设都会出错。
  const input = validateInput({
    channels: [{ id: 'c', budget: 2 }],
    exposureLowerBound: 0,
    groups: [{ id: 'A', channel: 'c', unitCost: 1, unitExposure: 0, revenue: [0, 10, 1, 30, 30, 30, 30, 30, 30, 30, 30] }],
  });
  const s = solve(input);
  assert.equal(s.totalRevenue, 10); // 预算 2 时量 1 最优（量 2 收益仅 1）
  assert.equal(s.totalCost, 1);
});

test('证书复核通过，篡改后失败', () => {
  const rng = seededRng(7);
  const input = randomInput(rng);
  const solution = solve(input);
  const cert = buildCertificate(input, solution, { checked: false, reason: '测试' });
  assert.equal(verifyCertificate(input, cert).ok, true);

  const tampered = { ...cert, objective: { ...cert.objective, revenue: cert.objective.revenue + 1 } };
  assert.equal(verifyCertificate(input, tampered).ok, false);

  const wrongInput = randomInput(seededRng(8));
  assert.equal(verifyCertificate(wrongInput, cert).ok, false);
});

test('样例配置（16 组）求解 + 证书复核 + 前 6 组穷举对照', () => {
  const input = generateSample();
  assert.equal(input.groups.length, 16);
  const solution = solve(input);
  assert.equal(solution.status, 'optimal');
  for (const ch of input.channels) {
    assert.ok(solution.channelSpend[ch.id] <= ch.budget);
  }
  assert.ok(solution.totalExposure >= input.exposureLowerBound);

  const cert = buildCertificate(input, solution, { checked: false, reason: '组合数过大' });
  const verify = verifyCertificate(input, cert);
  assert.deepEqual(verify.errors, []);

  // 取前 6 个广告组构成小实例，穷举对照 DP。
  const small: PlanInput = { ...input, groups: input.groups.slice(0, 6) };
  assert.ok(bruteForceCombinations(small.groups.length) <= 2_000_000);
  assert.ok(solutionsAgree(solve(small), bruteForce(small)));
});

test('输入校验拒绝非法数据', () => {
  assert.throws(() => validateInput({ channels: [], exposureLowerBound: 0, groups: [] }), /channels/);
  assert.throws(
    () =>
      validateInput({
        channels: [{ id: 'c', budget: 1 }],
        exposureLowerBound: 0,
        groups: [{ id: 'g', channel: 'c', unitCost: 1, unitExposure: 1, revenue: [0, 1, 2] }],
      }),
    /revenue/,
  );
  assert.throws(
    () =>
      validateInput({
        channels: [{ id: 'c', budget: 1.5 }],
        exposureLowerBound: 0,
        groups: [],
      }),
    /budget/,
  );
});

test('文件级流水线：写配置 -> 读取校验 -> 求解 -> 证书 -> 复核', () => {
  // 与 CLI 相同的处理链路（沙箱内无法派生子进程，故进程内验证）。
  const configPath = '/tmp/pipeline-config.json';
  writeFileSync(configPath, JSON.stringify(generateSample(), null, 2) + '\n');
  const input = validateInput(JSON.parse(readFileSync(configPath, 'utf8')));
  const solution = solve(input);
  assert.equal(solution.status, 'optimal');
  const cert = buildCertificate(input, solution, { checked: false, reason: '组合数过大' });
  const certPath = '/tmp/pipeline-cert.json';
  writeFileSync(certPath, JSON.stringify(cert, null, 2) + '\n');
  const loaded = JSON.parse(readFileSync(certPath, 'utf8'));
  const result = verifyCertificate(input, loaded);
  assert.deepEqual(result.errors, []);
  assert.ok(result.ok);
});
