# 清算库（不可拆票据的最小罚费清算）

给定至多 **16 笔不可拆票据**（付款方、收款方、整数金额、拒付罚费）和各账户初始余额，
选择一个执行子集与执行顺序，使得：

- 每笔被执行的票据在其执行时刻，付款方余额 ≥ 票据金额（余额不足即不可执行）；
- 未执行的票据视为拒付，计入其罚费；
- 目标：**总罚费最小**，并给出合法执行序与逐步余额证书。

金额为整数，内部统一使用 `bigint` 计算，无浮点误差。仅使用 Node.js 内置模块，零运行时依赖。

## 算法

关键观察：执行任意票据集合 S 后，各账户余额只取决于 S（与顺序无关），
因此「S 是否可按某种顺序执行」可用子集 DP 判定：

```
feasible[mask] = OR over j in mask of
    feasible[mask \ {j}] 且 执行 mask \ {j} 后 payer(j) 的余额 >= amount(j)
```

在所有可行 mask 中取「已执行票据罚费之和最大」者，即等价于总拒付罚费最小；
沿父指针回溯即得一个合法执行序。复杂度 `O(2^n * n * k)`（n ≤ 16，k 为账户数）。

## 验证（三重独立交叉验证）

1. **证书回放** `verifyCertificate`：从初始余额逐步重放执行序，校验每步
   付款方余额充足、前后余额与证书一致、拒付罚费之和等于声称的最小罚费。
2. **穷举子集 × 穷举顺序** `bruteForce`（`src/verify.ts`）：对所有 `2^n` 个子集，
   用带回溯剪枝的全排列搜索独立判定可行性，与 DP 的最优值逐一比对（n ≤ 10）。
3. **前向 DP** `forwardDpMinPenalty`：从空集出发按「余额足够即可追加票据」独立扩展
   可达集合，与后向 DP 交叉核对（用于 n = 16 的随机用例）。

## 使用

```bash
npm test        # 编译 + 运行全部测试（node:test）
npm run demo    # 求解 instances/sample.json 并打印逐步余额证书
npm start -- path/to/instance.json   # 求解自定义实例
```

实例格式（金额可写字符串或整数）：

```json
{
  "initialBalances": { "A": "0", "B": "100", "C": "10" },
  "bills": [
    { "id": "b1", "payer": "B", "payee": "A", "amount": "60", "penalty": "3" }
  ]
}
```

## 项目结构

- `src/clearing.ts` — 问题建模、子集 DP 求解、证书生成与回放验证
- `src/verify.ts` — 独立穷举验证（全子集 × 全排列）与前向 DP 交叉验证
- `src/cli.ts` — 命令行入口：求解、打印证书、现场跑三重验证
- `test/clearing.test.ts` — 14 个测试（构造用例 + 确定性随机用例）
- `instances/sample.json` — 示例实例

## 实际运行结果（2026-10-05，Node v22.22.1，tsc 7.0.2）

`npm test`：14/14 通过。

```
ok 1 - sample: order-dependent chain with one strategic rejection
ok 2 - all bills payable: nothing rejected
ok 3 - nothing payable: everything rejected, penalties summed
ok 4 - empty input: zero penalty, empty certificate
ok 5 - execution order matters: payer must be funded first
ok 6 - accepting a cheap bill can be worse than rejecting it
ok 7 - self-transfer requires sufficient balance but changes nothing
ok 8 - 16-bill chain: full execution, zero penalty
ok 9 - certificate detects tampered balances
ok 10 - certificate detects illegal execution order
ok 11 - certificate detects understated penalty
ok 12 - input validation rejects malformed problems
ok 13 - randomized n<=8: DP equals exhaustive subset x permutation search
ok 14 - randomized n=16: DP equals forward DP, certificate replays
# tests 14
# pass 14
# fail 0
```

其中测试 13 以固定种子生成 150 个 n ≤ 8 的随机实例，逐一对照 DP 与
全子集 × 全排列穷举的最小罚费；测试 14 以固定种子生成 30 个 n = 16 的
随机实例，对照后向 DP 与前向 DP 并回放证书。

`npm run demo`（`instances/sample.json`）实际输出：

```
=== Clearing Solution ===
bills: 4
minimum penalty: 8
execution order: b1 -> b2 -> b3
rejected: b4(penalty 8)

=== Step-by-step Balance Certificate ===
initial: A=0  B=100  C=10
step 1: b1  B -> A  amount=60  (payer 100 >= 60: OK)
  after: A=60  B=40  C=10
step 2: b2  A -> C  amount=50  (payer 60 >= 50: OK)
  after: A=10  B=40  C=60
step 3: b3  C -> B  amount=40  (payer 60 >= 40: OK)
  after: A=10  B=80  C=20
final: A=10  B=80  C=20

=== Verification ===
certificate replay: PASS
forward-DP cross-check: PASS (minPenalty=8)
exhaustive subset x permutation check: PASS (minPenalty=8, feasible subsets=6)
```

示例说明：b4（B→C 90）与 b1→b2→b3 资金链冲突——执行 b1 后 B 只剩 40，
经 b3 回补也仅 80 < 90；拒付 b4（罚 8）优于拒付 b1/b2/b3（合计罚 14），
故最优解为执行 b1→b2→b3、拒付 b4，最小罚费 8。
