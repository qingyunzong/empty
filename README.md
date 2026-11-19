# 副本裁决库（Replica Arbitration Library）

供自动扩缩控制面的调谐循环调用的 TypeScript 纯函数库。给定当前副本、各容器
利用率指标、带时间戳的稳定窗口历史建议与策略参数，输出**唯一**期望副本数，
以及该值的容器/窗口/边界依据。

## 裁决管线

`decide(input)` 严格按下列顺序执行，每一阶段的中间值都会写入返回对象，便于
调谐循环审计：

1. **容器建议**：每个容器独立给出
   `recommended = ceil(currentReplicas * currentUtilization / targetUtilization)`，
   使用精确整数比（`src/arithmetic.ts`），避免浮点误差。
2. **取最大值候选**：`candidateReplicas = max(各容器 recommended)`，并记录首个
   达到该最大值的容器名 `candidateContainer`（并列为确定性的先声明者胜出）。
3. **稳定窗口**：仅当候选值 **小于** 当前副本（即拟缩容）时才查询窗口；窗口为
   闭区间 `[now - stabilizationWindowMs, now]`，两端边界均包含。取窗口内副本
   峰值作为 `stabilizedReplicas = max(candidate, 窗口峰值)`。
   - 扩容（候选 ≥ 当前）**不查询、不等待**窗口，即时生效。
   - 缩容必须被窗口内峰值托底，因此只在窗口建议回落之后才真正缩小。
   - 窗口为空或零宽窗口中没有当前时刻样本时，不产生任何延迟。
4. **每周期最大比例钳制**：方向由稳定后的值与当前副本比较决定。
   - 扩容上界 `ceil(current * (1 + maxScaleUpRatio))`，向上取整，绝不超额扩容。
   - 缩容下界 `floor(current * (1 - maxScaleDownRatio))`，向下取整，绝不超额缩容。
   - 比例为 0 表示该方向本周期禁止移动。
5. **最小副本钳制**：结果不低于 `policy.minReplicas`，触发时依据标记为 `min`。
6. **动作与去抖**：与当前副本比较得到 `scale-up | scale-down | none`；期望值
   等于当前值时输出 `none` 且依据为 `current`，相同输入反复调用结果一致，不抖动。

## 依据（basis）

返回对象的 `basis` 取 `container | window | min | current`，配合 `basisDetail`
人类可读说明；同时返回 `candidateReplicas`、`stabilizedReplicas`、
`clampedReplicas`、每个容器的 `containerTraces`、被纳入窗口的样本
`windowConsidered` 及 `windowPeak/windowPeakAt`，完整解释最终值的来源。

## 输入约定

- 副本数、利用率、时间戳均为整数（利用率为正整数，比例为有限非负数）。
- `maxScaleDownRatio ∈ [0,1]`，`maxScaleUpRatio ≥ 0`。
- 容器列表非空且名称唯一；非法输入抛出 `TypeError/RangeError`。

## 独立参考实现与差分测试

期望结果**绝不**由被测库生成：

- `test/oracle.ts` 是独立参考实现，不 import `src/` 或 `index.ts` 中的任何内容，
  采用不同的命令式结构、独立的整数刻度（1000 vs 库内 10000）与独立取整/校验逻辑。
- `test/golden.ts` 的期望值全部手工计算并硬编码，再与参考实现交叉核对。
- `test/differential.ts` 的所有期望值均来自 `referenceDecide`，被测库 `decide`
  只提供被比较值；并含静态卫生检查，防止参考实现反向依赖被测库。

穷举场景族：

- **族 A 多容器建议交叉**：双容器 4×6×4×6×4 = 2304 个组合（×4 组当前副本），
  外加三容器 3^6 = 729 个全组合，断言候选值恒为各容器建议最大值。
- **族 B 窗口恰含边界**：样本时间覆盖下界外侧、下界、内部、上界、未来，验证
  闭区间包含性、时间排序、峰值选择与零宽/空窗口语义。
- **族 C 最大比例截断**：扩/缩两个方向各 5×5 比例 × 5 种指标方向，断言向上
  取整的扩容上界与向下取整的缩容下界。
- **族 D 最小副本钳制**：跨扩、缩、持平场景枚举 6 个最小副本档位。
- 另有 4000 个固定种子随机端到端差分用例。

## 构建与测试

本环境的 Node 未内置原生 TypeScript 执行，因此使用全局 `tsc` 先做严格类型检查
并输出到 `dist/`，再以 Node 运行编译产物（零第三方依赖）：

```bash
npm run typecheck   # 严格类型检查（noEmit）
npm run build       # 编译到 dist/
npm test            # pretest 编译后运行 golden + differential 全部用例
```

## 代码布局

- `src/types.ts`：输入/输出类型。
- `src/arithmetic.ts`：精确整数比例与取整助手。
- `src/decide.ts`：裁决管线与输入校验。
- `index.ts`：公共导出。
- `test/oracle.ts`：独立参考实现（期望值来源）。
- `test/golden.ts`：手工黄金用例。
- `test/differential.ts`：穷举与随机差分测试。
