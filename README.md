# settle-dsl

一个小型可审计结算 DSL：清算所运营方把「手续费、增值税、净额轧差」规则交给审计复核。
规则文件经 **词法分析 → Pratt 解析 → 静态类型/作用域检查 → 编译为自定义字节码 → 栈式 VM 执行**，
每个批次产出可重放验证的结算证书（规则哈希、输入哈希、字节码哈希、轨迹摘要）。

仅使用 Node.js 标准库（Node >= 22），单机离线可运行。

## 快速开始

```bash
node --test                                            # 运行全部测试
node bin/settle.js hash examples/rules.stl             # 查看规则文件与逐规则哈希
node bin/settle.js run examples/rules.stl examples/input.json --cert cert.json
node bin/settle.js verify examples/rules.stl examples/input.json --cert cert.json
```

`run` 向 stdout 输出每笔流水的费用/税额/净额（JSON），并把证书写入 `--cert` 指定的文件；
`verify` 重新执行整个批次并与证书逐字段比对（重放验证），一致输出 `{"ok": true}`，否则以非零码退出。

## DSL 语法

```
# 注释：# 或 // 到行尾
param fee_rate: rate = 0.0015r        # 规则参数（全局常量）
let min_fee: money = 0.50             # 全局 let 常量

rule fee(amount: money, day: date) -> money {
  let raw: money = amount * fee_rate  # 规则内 let 常量
  if raw < min_fee { min_fee } else { raw }
}
```

- **字面量**：金额 `12.34`（最多两位小数，禁止科学计数法 `1e5`）、费率 `0.06r`（最多六位小数，
  禁止负费率字面量）、日期 `2024-01-15`（校验真实历法日期）、布尔 `true`/`false`。
- **类型**：`money`（整数分）、`rate`（整数微率，1e6 = 1）、`date`（纪元日）、`bool`。
  无隐式转换：`1.00 + 0.06r` 是 `E_TYPE`。
- **运算**（Pratt 解析，优先级由低到高）：`or` < `and` < `==`/`!=` < `<`/`<=`/`>`/`>=`
  < `+`/`-` < `*`/`/` < 一元 `-`/`not` < 规则调用；支持括号与 `if ... { } else { }` 表达式。
  `money * rate -> money`（四舍五入到分）、`rate * rate -> rate`、`rate / rate -> rate`。
- **作用域**：`let` 为常量；规则参数遮蔽同名全局；内层块可遮蔽外层；同作用域重复
  `let` 报 `E_SCOPE`；未绑定变量报 `E_SCOPE`。
- **执行**：类型检查通过后编译为自定义字节码（`PUSH_CONST/LOAD/STORE/算术/比较/跳转/CALL/RET`，
  `and`/`or` 经跳转短路），由栈式 VM 执行；金额用 BigInt 分、费率用 BigInt 微率，舍入为
  round-half-up（四舍五入）。

## 输入与证书

输入 JSON 含账户流水与规则哈希：

```json
{
  "rulesHash": "sha256:...",                       // 整文件哈希；或 {"fee": "sha256:...", ...} 逐规则钉住
  "flows": [{ "id": "t-001", "amount": "1000.00", "date": "2024-01-15", "plan": "std" }]
}
```

- 每笔流水调用 `fee`/`tax`/`net` 三条规则（签名须为 `(amount: money, day: date) -> money`）；
  可选 `plan` 字段优先匹配 `fee_<plan>` 等规则，便于多套费率并存。
- 证书（`--cert` 输出）包含：`rulesHash`（实际执行的规则与被触达的全局，逐条源码哈希）、
  `inputHash`（输入文件哈希）、`bytecodeHash`（逐条字节码哈希）、
  `traceSummary`（轨迹步数与轨迹哈希）、`results`（每笔费用/税额/净额）。
- 因为证书只记录**实际执行到**的规则哈希，修改一条规则只会使受影响批次的证书变化，
  未受影响批次凭其钉住的规则哈希仍可复跑且证书逐字节不变（见验收测试 4）。

## 错误约定

词法/语法/类型/作用域/运行时错误分别以 `E_LEX`/`E_PARSE`/`E_TYPE`/`E_SCOPE`/`E_RT` 报告。
出错时向 stderr 输出 JSON 并以非零码退出：

```json
{"error":{"code":"E_LEX","message":"money literal allows at most 2 decimal places","line":1,"col":16}}
```

## 测试

```bash
node --test
```

验收标准对应 `test/acceptance.test.js`：三类规则跑通且证书可重放（acceptance 1）；
`1.005`/负税率/重复 `let`/未绑定变量分别报 `E_LEX`/`E_TYPE`/`E_SCOPE`/`E_SCOPE`（acceptance 2）；
100 笔随机流水与独立四舍五入参考实现逐笔对照（acceptance 3）；
修改一条规则后仅受影响批次证书变化（acceptance 4）。
