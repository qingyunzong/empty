# redflush-lp

税务平台红冲校验：用**精确有理线性规划**（维度 ≤ 3）判定红冲（credit）是否把原发票的
金额、税率、折扣约束**完全对偶冲回**（容差为零）。仅 Node.js 22 标准库，测试用 `node:test`。

## 用法

```bash
node cli.js commands.json     # 或 cat commands.json | node cli.js
node --test                   # 运行全部测试
```

输入是命令数组（或 `{"commands": [...]}`），输出是每个命令的结果 JSON 数组。

### 命令

- `{"cmd":"invoice","id","vars":[...],"constraints":[{"coefs":[...],"op":"<=|>=|==","rhsNum":n,"rhsDen":d}]}`
  登记发票。维度 = `vars.length`；`coefs` 支持整数、`"p/q"`、`[n,d]`、`{"num","den"}`。
- `{"cmd":"credit","refId","id"?,"constraints":[...]}` 对发票 `refId` 挂红冲约束
  （应为原约束的对偶否定）。未给 `id` 时自动分配。
- `{"cmd":"voidCredit","id"}` 撤销红冲、恢复原发票约束集。
- `{"cmd":"check","invoiceId"}` 对「发票约束 ∪ 活跃红冲约束」做精确可行性判定。

### 结果

- `SAT`：附 `vertex`，坐标为最简分数（边界含等号，闭半平面）。
- `UNSAT`（`error: E_UNSAT`）：附 `violated`（最小不可约约束子集 IIS 的约束 id）与
  `certificate.multipliers`（Farkas 乘子 λ ≥ 0，满足 Σλa = 0 且 Σλb < 0，可精确验证）。
- `UNDECIDED`：仅当维度 N > 3（`error: E_DIM`）。
- 错误码：`E_DIM`（维度超限 / 系数长度不符）、`E_REF`（未知引用）、
  `E_PINNED`（撤销被后续 check 证书引用的红冲）、`E_UNSAT`。

## 核心机制

- **有理数**：BigInt 分子分母，全程精确，自动约分（`src/rational.js`）。
- **精确顶点枚举**（`src/lp.js`）：非空多面体必含一个点，它是某个行子集 × 列子集
  构成的非奇异方阵的解（其余变量取 0）。枚举所有这样的组合并精确求解（BigInt 高斯
  消元，`src/linsolve.js`），优先返回满秩真顶点；因此无顶点的无界区域也能判定。
- **IIS**：删除法求不可约不可满足子集。
- **Farkas 证书**：Fourier-Motzkin 消元并跟踪乘子，得到 λ ≥ 0 使 Σλa = 0、Σλb < 0；
  `verifyCertificate` 用 O(m·n) 精确算术独立验证。
- **钉住（pin）**：`check` 的 UNSAT 证书引用某红冲的约束时，该红冲被钉住，
  `voidCredit` 返回 `E_PINNED`。

## 验收对照

| 验收 | 测试 |
| --- | --- |
| 完全红冲 SAT（顶点 = 原发票点） | `test/engine.test.js` acceptance 1 |
| 少冲一分钱 UNSAT 且证书可 verify | `test/engine.test.js` acceptance 2 |
| 撤销被引用红冲报 E_PINNED | `test/engine.test.js` acceptance 3、`test/cli.test.js` |
| N≤5 随机约束对照（独立 FM oracle + 网格枚举 + 精确判定） | `test/random.test.js` |
