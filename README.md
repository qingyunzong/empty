# redflush-lp

税务平台红冲校验库与 CLI:用**精确有理数线性规划**(维度 ≤ 3)判定红冲是否把原发票的
金额、税率、折扣约束完全冲回。仅使用 Node.js 22 标准库,测试使用 `node:test`。

## 语义

- `invoice{id, vars, constraints}` 登记发票约束系统,变量数 = 维度(1..3)。
- `credit{refId, constraints}` 登记引用发票的红冲单(自动分配 id `C1`, `C2`, ...)。
- `check{invoiceId}` 判定 **发票约束 ∪ 所有有效红冲约束** 的可满足性:
  - 完全红冲:每条原约束 `a·x ≤ b` 都有红冲对偶 `a·x ≥ b`(**零容差**精确抵消),
    交集钉在原边界点上 → `SAT`,输出见证点与全部顶点(最简分数)。
  - 少冲一分钱(如原发票 `amount ≥ 100`、红冲 `amount ≤ 99.99`)→ `UNSAT`,
    输出被违反约束、最小不可约子集(IIS)与可验证证书。
- `voidCredit{id}` 作废红冲;若已有 `check` 引用其证书 → `E_PINNED`,否则移除。
- 所有半平面均为闭(**边界含等号**),`op ∈ {<=, >=, ==}`。

## 约束格式

```json
{ "coefs": [[-13, 100], 1], "op": "<=", "rhsNum": 0, "rhsDen": 1 }
```

- `coefs[i]` 支持:整数、`"p/q"` 字符串、`[num, den]`、`{num, den}`。
- `rhs = rhsNum / rhsDen`(整数或数字字符串)。
- 约束 id 自动分配:`<单据id>#c<序号>`;`==` 展开为两个半平面,证书以
  `id[<=]` / `id[>=]` 引用单个半平面。

## 核心机制(src/lp.js)

1. 约束归一化为整数系数的 `a·x ≤ b`(通分 lcm)。
2. **精确顶点枚举**:任取 n 个约束边界,Cramer 法则精确求交点,保留满足全部约束者。
3. 无界区域:加入边长超过 Cramer 界 `n!·Mⁿ` 的包围盒,非空区域必有顶点落入盒内,
   保证判定完备(未决只可能来自维度超限 N>3,即 `E_DIM`)。
4. UNSAT 时删除过滤法求**最小不可约子集**(每删一条都可满足);证书可被
   `verifyCertificate` 独立精确验证(不可满足性 + 极小性)。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_DIM` | 维度 > 3(或 < 1)、系数个数与变量数不符 |
| `E_REF` | 引用了不存在的发票 / 红冲 / 证书约束 |
| `E_PINNED` | 作废已被 check 证书引用的红冲 |
| `E_UNSAT` | 约束系统不可满足(附带 IIS 证书) |

## CLI

```sh
node cli.js session.jsonl   # 或 stdin;支持 JSON 数组或 JSON Lines
```

操作:`invoice` / `credit` / `voidCredit` / `check` / `verify`(验证证书)。
每个操作输出一行 JSON;任一操作报错(含 `E_UNSAT`)时退出码为 1。

## 测试(node --test)真实结果

最近一次完整运行(2026-10-03,Node v22.22.1):

```
✔ test/acceptance.test.js   8 个子测试全部通过
✔ test/cli.test.js          5 个子测试(1 个因沙箱禁 spawn 跳过;CLI 已手动验证)
✔ test/random.test.js       900 个随机系统(维度 1/2/3,约束数 ≤ 5)
# tests 3  pass 3  fail 0
```

- 验收 1:完全红冲 `SAT`,见证点 `{amount: "100", tax: "13"}`,6/6 约束精确对偶抵消。
- 验收 2:少冲一分钱 `UNSAT` + `E_UNSAT`,IIS 证书经 `verifyCertificate` 验证有效。
- 验收 3:作废被引用红冲 → `E_PINNED`。
- 验收 4:900 个随机系统与独立 Fourier-Motzkin 精确消元 oracle 全部一致
  (560 SAT / 340 UNSAT),340 个 IIS 证书全部验证通过,359 个网格见证点全部确认。

CLI 手动验证(真实输出):

```
{"op":"check","status":"SAT","witness":{"amount":"100","tax":"13"},...,"cancellation":{"total":4,"canceled":4,"uncanceled":[]}}
{"op":"voidCredit","error":"E_PINNED","message":"credit C1 is referenced by an issued check certificate"}
{"op":"check","status":"UNSAT","error":"E_UNSAT","violated":["INV-1#c0"],"iis":["C1#c0[<=]","INV-1#c0[>=]"],...}
```
