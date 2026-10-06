# threshold-calibrator

校准 CLI：为 ≤8 个组分别选择接受阈值（整数分数，接受当且仅当 `score >= threshold`），
在全组假阳性（FP）总数不超过输入预算的约束下，先最小化假阴性（FN）总数，
再取字典序最小的阈值向量。分数并列的样本必然同判（阈值语义天然保证）。

## 使用

```bash
npm run build                                  # 编译（零依赖，需全局 tsc）
node dist/src/cli.js init data.json            # 新建空数据集
node dist/src/cli.js add data.json A s1 7 1    # 添加样本（版本 +1）
node dist/src/cli.js remove data.json A s1     # 删除样本（版本 +1）
node dist/src/cli.js show data.json            # 查看数据集
node dist/src/cli.js calibrate data.json       # 求解 + 混淆矩阵 + DP 证书 + 穷举核验
node dist/src/cli.js calibrate data.json --json       # 纯 JSON 证书输出
node dist/src/cli.js calibrate data.json --cap 5000   # 调整穷举组合数上限
npm test                                       # 编译并运行全部测试
```

## 数据集格式

```json
{
  "version": 1,
  "budget": 2,
  "groups": [
    { "name": "A",
      "samples": [ { "id": "a1", "score": 9, "label": 1 } ] }
  ]
}
```

- `budget`：全局 FP 预算（非负整数）。
- `groups`：至多 8 组，组名唯一；`score` 必须为整数，`label` 为 0/1，组内 `id` 唯一。
- 每次 `add` / `remove` 都会校验并使 `version` 递增，便于追踪样本版本。

## 算法与最优性证书

1. **候选阈值**：每组取所有不同分数及 `max+1`（全拒），空组取 `{0}`。
   并列分数同判；对 (fp, fn) 做 Pareto 剪枝，相同 (fp, fn) 保留最小阈值，
   保证字典序 tie-break 的精确性。
2. **DP**：`dp[f]` = 已处理组在恰好使用 f 个 FP 时的最优（FN 最小，
   再按阈值前缀字典序最小）。字典序对前缀一致，故逐组转移正确。
   最终在所有 `f <= budget` 上取最优。
3. **证书输出**：每组 Pareto 选项、DP 末层表（每个 f 的 FN 与阈值向量）、
   最优解（逐组阈值、总 FN/FP）、以及独立的小域穷举核验结果
   （对各组选项的笛卡尔积全枚举，组合数超过 `--cap` 时跳过并说明）。
   核验与 DP 一致时证书有效；不一致时 CLI 以非零码退出。

## 输出内容

- 逐组混淆矩阵（TP/FP/TN/FN）与所选阈值；
- 最优阈值向量、总 FN、总 FP；
- DP 最优性证书（JSON），含穷举核验结论。

示例见 `examples/dataset.json`，测试见 `test/calibrate.test.ts`
（含 300 组随机小域用例的 DP ↔ 穷举一致性校验）。
