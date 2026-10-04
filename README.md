# signal-window

信号库：对最近 k 个有效样本计算加权平均，全程使用精确有理数（BigInt 分数）运算，
仅依赖 Node.js 内置模块，TypeScript 编写。

## 运行

```sh
npm test        # tsc 编译 + node --test 运行全部测试
npm run build   # 仅编译到 dist/
```

环境要求：Node.js（开发于 v22）与任意 `tsc`（本仓库用全局 TypeScript 7 编译）。
无 npm 依赖；`types/node-shims.d.ts` 为所用内置模块提供最小类型声明。

## 数据与权重模型

时间轴由槽位（slot）组成，每个槽位是**样本**（值 + 非负整数权重）或**缺测**。
缺测槽位占据时间位置但不计权重。槽位 `i` 的有效权重：

```
effW(i) = weight(i) * (period + (i mod period)) / (period * (1 + gapBefore(i) + gapAfter(i)))
```

- **时间相位**：`period + (i mod period)`，由槽位在时间轴上的相位决定；
- **缺测距离**：`gapBefore/gapAfter` 为紧邻该样本的连续缺测槽位数，越靠近缺测权重越低。

分数 = 最近 `k` 个有效样本的 `Σ(effW·value) / Σ(effW)`。
窗口内权重全为零（或无有效样本）时返回空（`null`）。

## API 摘要（src/signal.ts）

- `appendSample(value, weight)` / `appendMissing()`：追加样本 / 缺测槽位。
- `average()`：最近 k 个有效样本的加权平均（`Rational | null`）。
- `correct(index, value, weight)`：更正样本；`delete(index)`：删除样本
  （槽位变为缺测，保留时间位置），后续窗口成员与相邻样本权重随之改变。
- `effectiveWeightAt(index)` / `windowIndices()`：检查权重与窗口。
- `checkpoint()` / `SignalSeries.resume(cp)`：暂停与恢复。检查点携带当前
  （可能未闭合的）窗口状态与源摘要（槽位计数、sha256 校验和、下一序号）；
  恢复时逐项校验，篡改或缺失即抛错。
- `branch()`：分支。槽位不可变、写时复制，分支上的更正/删除不影响旧视图。

## 对照验证

- `src/reference.ts` 是独立的"完整精确重采样再加权"参照模型：朴素重放事件日志、
  每次查询从头直接做分数计算（有效权重公式独立重写，不共享窗口代码）。
- 测试（`test/signal.test.ts`）在更正、删除、分支、随机模糊历史（400 步）之后，
  将增量实现与参照模型逐步对照；检查点暂停/恢复后与不间断运行对照。
- 实际测试结果见 `RESULTS.md`。
