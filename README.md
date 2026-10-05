# signal-weighted-window

信号库：计算最近 k 个有效样本的加权平均。仅使用 TypeScript + Node.js 内置库，无第三方运行时依赖。

## 模型

- 时间轴上每个位置要么持有一个样本 `{ value, weight }`，要么缺失（`null`）。
- 缺失样本占时间位置，但不计权重、不计入窗口的 k 个有效样本。
- 输入权重必须是非负整数；窗口内有效权重之和为 0（全零权重）时返回空（`null`）。
- 有效权重 = 输入权重 × 时间相位因子 × 缺测邻近因子：
  - 相位因子：`1 + (t mod 4)`，随时间相位循环；
  - 邻近因子：`(1 + d前) × (1 + d后)`，由前后最近缺测位置的距离共同决定（上限 3，触及边界按上限计）。

## 功能

- `SignalSeries.windowAverage(end, k)`：最近 k 个有效样本的加权平均（增量权重缓存路径）。
- `directWindowAverage(cells, end, k)`：直接分数计算，从原始数据逐位置重推权重，用作对照。
- `correct(t, sample)` / `delete(t)`：更正/删除样本；删除使位置变为缺失，会改变后续窗口成员与相邻样本的缺测距离（相邻权重随之改变），增量缓存仅局部重算。
- `checkpoint()` / `SignalSeries.resume(payload, source)`：检查点暂停与恢复；检查点携带未闭合窗口（末尾最近 k 个有效样本位置）与源摘要（SHA-256），恢复时校验摘要与未闭合窗口，不匹配即拒绝。
- `branch()`：分支更正后旧视图保留；`src/reference.ts` 提供完整精确重采样再加权模型（BigInt 有理数），用于核对分支与旧视图。

## 测试

```sh
npm test
```

实际测试结果见 `RESULTS.md`。
