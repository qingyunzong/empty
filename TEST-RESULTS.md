# 实际运行实录

环境: v22.22.1, npm 9.2.0, tsc Version 7.0.2, Linux 6.6.114.1-microsoft-standard-WSL2 x86_64
日期: 2026-10-05 21:15:32 CST

## `npm test`

```
> ad-placement-planner@1.0.0 test
> npm run build --silent && node dist/test/solver.test.js
TAP version 13
ok 1 - DP 与穷举在 120 个随机小实例上结论一致
  ---
  duration_ms: 47.415228
  type: 'test'
  ...
ok 2 - 收益并列时选择成本最低的方案
  ---
  duration_ms: 2.629367
  type: 'test'
  ...
ok 3 - 分渠道预算各自独立生效
  ---
  duration_ms: 0.50631
  type: 'test'
  ...
ok 4 - 曝光下限不可达时报告不可行
  ---
  duration_ms: 0.352754
  type: 'test'
  ...
ok 5 - 非线性（非单调）收益表被精确处理
  ---
  duration_ms: 0.419249
  type: 'test'
  ...
ok 6 - 证书复核通过，篡改后失败
  ---
  duration_ms: 2.232978
  type: 'test'
  ...
ok 7 - 样例配置（16 组）求解 + 证书复核 + 前 6 组穷举对照
  ---
  duration_ms: 97.005912
  type: 'test'
  ...
ok 8 - 输入校验拒绝非法数据
  ---
  duration_ms: 0.904179
  type: 'test'
  ...
ok 9 - 文件级流水线：写配置 -> 读取校验 -> 求解 -> 证书 -> 复核
  ---
  duration_ms: 48.819224
  type: 'test'
  ...
1..9
```

## `node dist/src/cli.js solve configs/small.json --cert /tmp/small-cert.json`（4 组小实例，自动穷举对照）

```
状态: 最优解
总收益: 58   总成本: 21   总曝光: 24（下限 8）
分渠道预算核销:
  search: 花费 12 / 预算 12（余量 0）
  social: 花费 9 / 预算 9（余量 0）
投放方案:
  g1 [search] 量=3 成本=6 曝光=6 收益=15
  g2 [search] 量=2 成本=6 曝光=2 收益=13
  g3 [social] 量=5 成本=5 曝光=10 收益=18
  g4 [social] 量=2 成本=4 曝光=6 收益=12
最优性证据: DP 状态数 117，前沿哈希 b74d06dbea3dcafc…
穷举对照: 14641 种组合，结论一致
证书哈希: 1ad6c275e7c113254de1a7ed6a53788b544ddc6a0b6670ba6d8d45915853294c
证书已写入: /tmp/small-cert.json
```

## `node dist/src/cli.js verify configs/small.json /tmp/small-cert.json`

```
证书复核通过：约束满足，且经重新精确求解确认为收益最大、并列成本最低。
```

## `node dist/src/cli.js solve configs/sample.json --cert /tmp/sample-cert.json`（16 组完整样例）

```
状态: 最优解
总收益: 495   总成本: 154   总曝光: 156（下限 40）
分渠道预算核销:
  search: 花费 60 / 预算 60（余量 0）
  social: 花费 45 / 预算 45（余量 0）
  video: 花费 49 / 预算 50（余量 1）
投放方案:
  g01 [search] 量=1 成本=3 曝光=2 收益=9
  g02 [social] 量=3 成本=6 曝光=3 收益=22
  g03 [video] 量=2 成本=6 曝光=8 收益=11
  g04 [search] 量=5 成本=15 曝光=15 收益=34
  g05 [social] 量=2 成本=10 曝光=2 收益=25
  g06 [video] 量=10 成本=10 曝光=10 收益=63
  g07 [search] 量=1 成本=4 曝光=2 收益=8
  g08 [social] 量=7 成本=7 曝光=28 收益=29
  g09 [video] 量=2 成本=8 曝光=2 收益=11
  g10 [search] 量=2 成本=10 曝光=2 收益=25
  g11 [social] 量=5 成本=10 曝光=15 收益=34
  g12 [video] 量=1 成本=4 曝光=2 收益=13
  g13 [search] 量=10 成本=20 曝光=20 收益=66
  g14 [social] 量=3 成本=12 曝光=9 收益=34
  g15 [video] 量=7 成本=21 曝光=28 收益=63
  g16 [search] 量=8 成本=8 曝光=8 收益=48
最优性证据: DP 状态数 25468，前沿哈希 4c3a5db96fbdf90e…
穷举对照: 跳过（组合数 11^16 = 45949729863572160 超过穷举上限）
证书哈希: 7ccce0d87a8a27b49963857561219767df6b1cd1d8e5a47315460b05108c2480
证书已写入: /tmp/sample-cert.json
```

## `node dist/src/cli.js verify configs/sample.json /tmp/sample-cert.json`

```
证书复核通过：约束满足，且经重新精确求解确认为收益最大、并列成本最低。
```
