# fee-dsl

基金 TA 费用 DSL：按合同计算申购费 / 赎回费，整数分运算、显式舍入指令、
每步记录余数，输出可验证的舍入路径证书。仅 Node.js 22 标准库，单机离线。

## 快速开始

```bash
node bin/fee.js calc examples/contract.fee examples/orders.json --cert
node bin/fee.js verify examples/contract.fee examples/orders.json examples/orders.cert.json
node --test
```

## DSL 语法

```
currency CNY;
rounding HALF_EVEN;            # HALF_UP | HALF_EVEN | DOWN

param ta_share = 6000bps;      # 合同级参数（bps 字面量）

class A {
  param min_sub_fee = 5.00;    # 份额类别默认参数，可被单笔订单 params 覆盖

  fee subscribe(amount: money) -> money {
    let gross = tier on amount {
      it < 1000000.00 -> amount * 120bps,
      it >= 1000000.00 and it < 5000000.00 -> amount * 100bps,
      it >= 5000000.00 -> amount * 80bps
    };
    let total = max(gross, min_sub_fee);
    allocate total {
      ta: ta_share;
      channel: 4000bps;
      residual -> "TA_POOL";   # 尾差归集户
    }
    conserve total == total;   # 守恒断言示例
    return total;
  }
}
```

- 字面量：`100.00`（money，恰好 ≤2 位小数，超精度报 `E_LEX`）、`120bps`（整数基点）、`7`（units）。
- 类型：`money` / `bps` / `units` / `bool`。`money*bps→money`（自动插入舍入指令）、
  `units*money→money`；`bps + money` 等混合运算静态拒绝（`E_TYPE`）。
- `tier on <expr> { cond -> value, ... else -> value }`：所有命中档并列求值，
  取费用最低者，全部并列档记入结果与证书；无命中且无 else 报 `E_TIER`。
- `allocate total { account: <bps>; ... residual -> "账户"; }`：按比例分账，
  每项独立舍入，尾差进入归集户；分项 + 尾差必须等于总额，否则 `E_CONSERVE`。
- `conserve a == b;`：显式守恒断言，不等即 `E_CONSERVE`。
- 内建函数：`min` / `max` / `clamp`；运算符：`+ - * < <= > >= == != and or not`。

## 订单格式

```json
{
  "orders": [
    { "id": "o1", "class": "A", "op": "subscribe",
      "args": { "amount": "10000.00" },
      "params": { "min_sub_fee": "3.00" } }
  ]
}
```

- `args` 按 fee 规则签名逐个校验；money 必须 ≤2 位小数字符串。
- 负数金额/份额 → `E_DOMAIN`；`shares` 为 0 → `E_DOMAIN`；超精度字面量 → `E_LEX`。
- `params` 覆盖合同级 / 类别级默认参数（按声明类型解析）。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_LEX` | 词法错误：超精度字面量、非法 bps、非法字符 |
| `E_PARSE` | 语法错误 |
| `E_TYPE` | 静态类型错误（如 bps 与 money 直接相加） |
| `E_NAME` | 未定义标识符 |
| `E_ORDER` | 订单错误：未知类别/操作/参数、缺参 |
| `E_DOMAIN` | 负数赎回、零份额 |
| `E_TIER` | 费率档无命中且无 else |
| `E_ROUND` | 舍入模式非法 / 证书舍入步骤重放不一致 |
| `E_CONSERVE` | 总费用 ≠ 分项和（含尾差） |
| `E_CERT` | 证书哈希 / 结果不匹配 |

## 证书

`--cert` 输出 JSON 证书：合同与订单的 SHA-256、每笔订单的完整 trace
（每条 `ROUND` 指令的输入、scale、余数、输出；`TIER` 命中与并列；`ALLOC`
分项与尾差）。`fee verify` 重放证书：逐步重算舍入、校验分项+尾差=总额、
重新执行合同并比对全部 trace。篡改舍入步骤 → `E_ROUND`，篡改分账 → `E_CONSERVE`。

## 目录

- `src/lexer.js` 词法器（严格小数 / bps / 关键字）
- `src/parser.js` Pratt 解析器（分层费率、min/max/clamp）
- `src/checker.js` 静态类型检查（bps/money/units）
- `src/compiler.js` 编译到字节码（显式 ROUND 指令）
- `src/vm.js` 栈式 VM（整数分、每步记录余数、守恒断言）
- `src/runtime.js` 订单校验与作用域（订单 > 类别 > 合同）
- `src/cert.js` 证书生成与重放验证
- `src/cli.js` / `bin/fee.js` CLI
