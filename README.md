# blend-cli

精确配比优化 CLI：从不超过 12 种液体中选取非负整数单位量，总量不超过 40，
使混合浓度落在有理闭区间 `[lo, hi]` 内；在所有可行向量中先最小化整数总成本，
再取数量向量字典序最小者。输出精确浓度（最简分数）与用量；无解时完成全部
搜索后才报告 `infeasible`。

## 构建与测试

```sh
npm run build   # tsc -> dist/
npm test        # 编译并运行 node:test 测试（含小域全向量核验）
```

## 使用

```sh
node dist/src/cli.js input.json [--max-total N]
cat input.json | node dist/src/cli.js
```

输入 JSON：

```json
{
  "liquids": [
    { "name": "water", "concentration": "0",   "cost": 1 },
    { "name": "syrup", "concentration": "3/4", "cost": 4 }
  ],
  "target": ["1/4", "1/2"],
  "maxTotal": 40
}
```

- `liquids`：1–12 种；`name` 可省（默认 `liquid-<i>`）；`concentration` 为有理数
  （`"p/q"`、十进制串或 JSON 数值，精确解析）；`cost` 为非负整数。
- `target`：闭区间 `[lo, hi]`，或 `{"min": lo, "max": hi}`。
- `maxTotal`：1–40，默认 40；命令行 `--max-total` 可覆盖。

输出（退出码 0）：

```json
{
  "status": "optimal",
  "cost": 5,
  "total": 2,
  "concentration": "3/8",
  "concentrationDecimal": 0.375,
  "amounts": [ { "name": "water", "amount": 1 }, { "name": "syrup", "amount": 1 } ],
  "vector": [1, 1],
  "nodesExplored": 196
}
```

`concentration` 为最简分数形式的精确浓度；`vector` 与输入液体顺序对齐。
无解时退出码 1 并输出 `{"status": "infeasible", "nodesExplored": ...}`；
输入非法时退出码 2。

## 算法与完备性

- 全部算术使用 BigInt 有理数（`src/rational.ts`），浓度约束
  `lo·A ≤ Σ w_i x_i ≤ Hi·A` 在公共分母下化为整数不等式，无浮点误差。
- 求解器（`src/solver.ts`）按字典序 DFS 枚举数量向量，仅在严格更小成本时
  更新最优解，因此同成本下保留字典序最小向量。
- 剪枝均不会丢弃能严格改进当前最优的向量，搜索是完备的：
  - 成本下界：已有同等或更优解时剪枝（字典序更晚的等成本向量必然更大）；
  - 浓度可达性：对剩余液体的浓度做连续松弛，解关于剩余总量 y 的两个
    线性不等式，得到整数区间为空则剪枝；
    gcd 剪枝：剩余液体的加权和必为 g = gcd(w_i..) 的倍数，目标窗口内无
    此类倍数则剪枝。
- 因此报告 `infeasible` 时，定义域内每个向量都已被排除（搜索完成）。

## 测试

- `test/rational.test.ts`：有理数解析/运算/取整。
- `test/solver.test.ts`：已知答案、字典序平局、边界总量、无解（含 Farey
  间隙区间）与 12 液体用例。
- `test/verify.test.ts`：小域全向量核验——对 400 组随机小实例（≤4 种液体、
  总量 ≤8）及结构化边界用例，把 `solve` 与 `bruteForce` 的结果同测试内独立的
  全向量枚举参考逐一比对（成本、向量、精确浓度）。
- `test/cli.test.ts`：CLI 输入校验、退出码与输出格式。
