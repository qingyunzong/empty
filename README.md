# lincon-solver

精确求解**线性不等式 + 同余约束**的命令行工具：变量取值于给定的 64 位有符号闭区间，
输出全部解的**最简步长区间**（`start / end / step / count`），或输出机器可读的**无解证书**。

## 特性

- **纯 bigint 精确计算**：全程任意精度整数，严格不等式通过整数平移处理
  （`a*x + b < 0` ⟺ `a*x + b + 1 <= 0`），**不做任何浮点转界**，
  因此在 `±2^63` 边界上也不会有精度损失。
- **同余约束**：`a*x ≡ r (mod m)` 用扩展欧几里得算法求解；多个同余用
  **广义中国剩余定理**（支持非互素模数）合并，冲突时给出 CRT 无解证书。
- **步长区间输出**：每个变量的解集为 `{ x : L ≤ x ≤ U, x ≡ r (mod m) }`，
  输出为最简形式 `{start, end, step, count}`（`start/end` 为最小/最大解，`step` 为合并后的模数）。
- **无解证书**：`bound-conflict`、`crt-conflict`、`congruence-unsolvable`、
  `equality-not-integral`、`constant-contradiction`、`no-solution-in-range`，
  均指明冲突来源约束。
- **缩小域穷举核验**：测试在小定义域上暴力枚举所有整数解，与求解器输出逐一比对
  （1500 个随机用例，含严格不等式 / 等式 / 同余 / 常量约束）。

约束限制：每条约束至多涉及一个变量（可分离系统）；多变量约束会被明确拒绝。

## 构建与测试

```sh
npm test          # tsc 编译 + node --test 运行全部测试
npm run build     # 仅编译到 dist/
```

无第三方运行时依赖；仅需 Node.js (>= 18) 与 TypeScript 编译器。

## 使用

```sh
# 命令行直接求解
node dist/src/cli.js solve --var 'x:[0,100]' -c '2*x + 3 <= 50' -c 'x % 7 == 3'

# JSON spec 文件（或 --file - 从 stdin 读取）
node dist/src/cli.js solve --file spec.json --enumerate --pretty
```

spec 文件格式（64 位边界建议用字符串表示）：

```json
{
  "variables": { "x": ["-9223372036854775808", "9223372036854775807"] },
  "constraints": ["2*x + 3 <= 50", "x % 7 == 3", "x < 9223372036854775807"]
}
```

约束语法：

| 形式 | 示例 |
| --- | --- |
| 不等式 | `2*x + 3 <= 50`，`x > -5`（支持 `< <= > >=` 及 `≤ ≥`） |
| 等式 | `3*x - 12 == 0` |
| 同余 | `(2*x + 1) % 6 == 4`、`2*x + 1 == 4 (mod 6)`、`2*x + 1 ≡ 4 (mod 6)` |

输出示例（SAT）：

```json
{ "status": "sat",
  "solutions": { "x": { "start": "3", "end": "17", "step": "7", "count": "3" } } }
```

输出示例（UNSAT）：

```json
{ "status": "unsat", "variable": "x",
  "certificate": { "type": "crt-conflict", "residue1": "1", "modulus1": "4",
                   "residue2": "2", "modulus2": "6", "gcd": "2", "detail": "..." } }
```

退出码：`0` = 有解，`1` = 无解（附证书），`2` = 输入/用法错误。

选项：`--enumerate[=N]`（解数 ≤ N 时列出全部解，默认 N=1000）、`--pretty`、`--help`。

## 代码结构

- `src/bigintmath.ts` — 精确整数运算：floor/ceil 除法、floor-mod、扩展 gcd、模逆
- `src/parser.ts` — 约束文本解析与规范化（严格不等式整数平移在此完成）
- `src/solver.ts` — 求解核心：区间收紧、等式定界、同余求解、广义 CRT 合并、证书生成
- `src/cli.ts` — 命令行接口（参数 / spec 文件 / 输出序列化 / 退出码）
- `test/` — 单元测试、64 位边界测试、缩小域穷举核验、CLI 端到端测试
