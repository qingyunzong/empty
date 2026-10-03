# fee-dsl — 基金 TA 费用 DSL 与可验证舍入证书

纯 Node.js 22 标准库实现（无第三方依赖），`node:test` 测试。覆盖申购费/赎回费的分层费率计算、整数分 VM、显式舍入指令、尾差归集与可重放证书。

## 快速开始

```bash
node bin/fee.js calc examples/sample.fee examples/orders.json --cert
node bin/fee.js verify examples/sample.fee examples/orders.cert.json
node --test        # 全量测试
```

## DSL 语法

```fee
contract "EquityFund-A" {
  defaults {                 # 份额类别默认参数（可被单笔订单 override）
    rate  = 25bps
    floor = 1.00 CNY
  }
  rounding HALF_EVEN         # HALF_UP | HALF_EVEN | DOWN
  residual to TAIL_ACCOUNT   # 尾差归集户
  fee = {
    tier on [0.00 CNY, 1000000.00 CNY)        fee = rate min floor
    tier on [1000000.00 CNY, 5000000.00 CNY)  fee = 15bps
    tier on [5000000.00 CNY, )                fee = 10bps max 5000.00 CNY
  }
}
```

- **字面量**：`25bps`（基点，整数）、`1.00 CNY`（金额，最多 4 位小数）、`100.00 units`（份额，最多 2 位小数）。超限精度 → `E_LEX`。
- **区间**：`[from, to)` 左闭右开，`]` 为闭右端，省略右端表示无穷。
- **min/max 子句**（合同语义）：`X min Y` = 最低收费 Y（取大），`X max Y` = 封顶 Y（取小）。
- **`+`**：仅允许同类型相加；`bps + money` → `E_TYPE`。
- **注释**：`#` 至行尾；`;` 可选分隔。

## 架构

```
src/lexer.js     严格词法：小数/基点/币种/舍入关键字，非法字符与畸形数字 → E_LEX
src/parser.js    Pratt 解析：分层费率、min/max 后缀、+ 中缀、参数引用
src/typecheck.js 静态类型：bps / money / units 三型分立，禁止跨型相加
src/compiler.js  编译到字节码（CONST_*/LOAD_PARAM/APPLY/CMP_*/MATCH/SELECT_MIN/ROUND/CONSERVE）
src/vm.js        栈式 VM：Rational 精确值 + 整数分舍入，逐步记录余数到证书
src/rounding.js  HALF_UP / HALF_EVEN / DOWN，返回 {rounded, remainder}
src/cert.js      证书生成与重放校验（sha256 合同指纹 + 逐步比对）
src/cli.js       fee calc / fee verify
```

## 语义要点

- **并列命中**：多档区间同时命中时，逐档求精确费用，取**最低**者，并在证书 `ties` 中列出全部并列档。
- **尾差守恒**：`totalFee + residual == exactFee` 恒等式每单校验；`residual`（亚分级）进入 `residual to` 指定归集户。违反 → `E_CONSERVE`。
- **订单校验**：负数赎回/负数金额、零份额 → `E_TIER`；金额超精度 → `E_LEX`；override 类型不符 → `E_TYPE`。
- **订单对账**：订单可携带 `expectedTotal`（渠道申报总额），与 VM 计算的分项和不等 → `E_CONSERVE`。

## 订单格式

```json
{
  "orders": [
    { "id": "A001", "type": "subscription", "amount": "100.00", "shares": "99.50" },
    { "id": "A003", "amount": "12345.6789", "overrides": { "rate": "20bps" } },
    { "id": "A009", "amount": "10000.00", "expectedTotal": "25.00" }
  ]
}
```

## 证书

`--cert` 生成 `<orders>.cert.json`：每单包含命中档、候选费用、并列列表、每步字节码轨迹（含 ROUND 余数）、总额、尾差与归集户、守恒恒等式。`fee verify` 重放全部步骤并逐字段比对，任何篡改 → `E_CONSERVE`。

## 错误码

| 代码 | 含义 |
|---|---|
| `E_LEX` | 词法/字面量错误（畸形数字、超精度、非法字符） |
| `E_PARSE` | 语法错误（缺少单位、缺少 residual 等） |
| `E_TYPE` | 静态类型错误（bps+money、override 类型不符） |
| `E_TIER` | 无命中档、负数赎回、零份额 |
| `E_ROUND` | 未知舍入模式 |
| `E_CONSERVE` | 守恒校验失败 / 证书重放不一致 |
