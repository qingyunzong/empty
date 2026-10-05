# 清算库（clearing-house）

输入至多 **16 笔不可拆票据**，每笔票据须一次性整额支付：执行时**付款方余额足够**才能支付，
否则该笔只能**拒付**并计入**罚费**。求**最小总罚费**及一个**合法执行顺序**，并输出逐步余额证书。
金额均为整数。仅使用 TypeScript + Node.js 内置库（`node:fs` / `node:test` / `node:assert`），零运行时依赖。

## 问题建模

- 账户集合与初始余额 `balances`；票据 `bills[i] = { id, from, to, amount, penalty }`。
- 关键观察：**付完某个子集 S 之后各账户余额与执行顺序无关**（只取决于 S 的净变动）。
  因此“子集 S 是否存在合法执行序”可以精确地做子集 DP：

  ```
  feasible[∅] = true
  feasible[S] ⟺ ∃ b∈S: feasible[S\{b}] 且 balance_{from(b)}(S\{b}) ≥ amount(b)
  ```

- 在所有可行子集中最大化“已付票据罚费之和”，等价于最小化拒付罚费总额。
- 沿 `parent` 指针回溯即得一个合法执行序；同一 DP 顺带精确统计每个子集的**合法执行顺序总数**
  （`orderCount[S] = Σ orderCount[S\{b}]`，对可作最后一步的 b 求和）。
- 复杂度：时间 `O(2^n · (n + A))`、空间 `O(2^n · A)`，n ≤ 16 时约 65536 个子集，毫秒级。

## 验证（三层）

1. **证书自洽**：按输出执行序逐步模拟，检查每步余额足够、借贷平衡、终态余额与独立重算一致、
   罚费与最优值一致（`src/certificate.ts`）。
2. **子集穷举交叉验证**：正向 DP（从空集逐步加入付得起的票据）与逆推 DP 的全部 2^n 个
   可行子集必须完全一致（`computeReachableForward`）。
3. **顺序穷举验证**：n ≤ 8 时枚举每个子集的每一种执行顺序（共 ≤ ⌊e·n!⌋ 个排列）逐步模拟，
   暴力最小罚费必须与 DP 一致（`src/bruteforce.ts`）。

## 用法

```bash
npm test          # 编译并运行全部测试（node:test）
npm run build     # 仅编译到 dist/
node dist/src/main.js examples/sample.json    # 求解并打印证书 + 验证摘要
node dist/src/main.js - < input.json          # 从标准输入读取
```

输入格式见 `examples/sample.json`（6 笔）与 `examples/demo16.json`（16 笔）：

```json
{
  "balances": { "A": 10, "B": 0 },
  "bills": [{ "id": "b1", "from": "A", "to": "B", "amount": 10, "penalty": 2 }]
}
```

## 目录

- `src/solver.ts` — 输入校验、子集 DP（逆推/正向）、最优解与执行序重构
- `src/bruteforce.ts` — 全排列穷举验证（n ≤ 8）
- `src/certificate.ts` — 逐步余额证书的生成、校验与格式化
- `src/main.ts` — 命令行入口
- `test/solver.test.ts` — 手工算例 + 随机交叉验证（300 组 n≤8、60 组 9≤n≤16）+ 16 笔压力
- `RESULTS.md` — 实际测试与示例运行输出
