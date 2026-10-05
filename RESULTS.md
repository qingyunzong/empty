# 实际测试结果

环境：Node.js v22.22.1，tsc 7.0.2，运行时间：2026-10-05 13:27:40 CST

## npm test

```
> signal-weighted-window@1.0.0 test
> tsc -p tsconfig.json && node --test dist/test/*.test.js
TAP version 13
# Subtest: dist/test/branch.test.js
ok 1 - dist/test/branch.test.js
  ---
  duration_ms: 543.569449
  type: 'test'
  ...
# Subtest: dist/test/checkpoint.test.js
ok 2 - dist/test/checkpoint.test.js
  ---
  duration_ms: 564.505814
  type: 'test'
  ...
# Subtest: dist/test/mutation.test.js
ok 3 - dist/test/mutation.test.js
  ---
  duration_ms: 664.167475
  type: 'test'
  ...
# Subtest: dist/test/weights.test.js
ok 4 - dist/test/weights.test.js
  ---
  duration_ms: 542.652568
  type: 'test'
  ...
# Subtest: dist/test/window.test.js
ok 5 - dist/test/window.test.js
  ---
  duration_ms: 519.171512
  type: 'test'
  ...
1..5
# tests 5
# suites 0
# pass 5
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 720.183817
```

## 逐用例明细（node --test-reporter=spec 直接运行各测试文件）

```
== dist/test/branch.test.js ==
ok 1 - 分支更正后旧视图保留并与精确模型一致
ok 2 - 分支删除样本后与精确重采样模型核对一致
ok 3 - 旧视图与分支的全零权重行为一致（均返回空）
# tests 3
# pass 3
# fail 0
== dist/test/checkpoint.test.js ==
ok 1 - 检查点携带未闭合窗口与源摘要
ok 2 - 暂停后恢复：未闭合窗口与源摘要吻合，续算结果一致
ok 3 - 源摘要不匹配时拒绝恢复
ok 4 - 未闭合窗口被篡改时拒绝恢复
# tests 4
# pass 4
# fail 0
== dist/test/mutation.test.js ==
ok 1 - 更正样本后与直接分数计算一致
ok 2 - 删除样本改变相邻权重
ok 3 - 删除样本改变后续窗口成员
ok 4 - 确定性随机操作序列下增量结果始终与直接计算一致
# tests 4
# pass 4
# fail 0
== dist/test/weights.test.js ==
ok 1 - 时间相位因子按周期循环
ok 2 - 缺测距离：前后最近缺测位置，越界按上限计
ok 3 - 邻近因子由前后距离共同决定
ok 4 - 有效权重 = 输入权重 × 相位 × 邻近因子
# tests 4
# pass 4
# fail 0
== dist/test/window.test.js ==
ok 1 - 最近 k 个有效样本的加权平均（手工核算）
ok 2 - 缺失样本占时间位置但不计权重、不计入 k
ok 3 - 全零权重返回空
ok 4 - 输入权重必须是非负整数
ok 5 - 窗口参数校验
ok 6 - 增量路径与直接分数计算一致
# tests 6
# pass 6
# fail 0
```
