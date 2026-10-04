# settle-dsl

一个用于清算所结算规则（手续费、增值税、净额轧差）的小型可审计 DSL。
规则编译为自定义字节码，由栈式 VM 执行；每次批价产出可重放验证的证书，
证明某次批价由哪份规则、哪条输入推出。仅依赖 Node.js 标准库。

## 要求

- Node.js 22（仅用标准库，无第三方依赖）

## 运行测试

```sh
node --test
```

（`npm test` 等价，package.json 中 `test` 脚本即 `node --test`。）

## CLI 用法

```sh
# 批价并输出证书
node bin/settle.js run examples/rules.stl examples/input.json --cert out.json

# 重放验证证书（重新编译、执行并逐字段比对）
node bin/settle.js verify examples/rules.stl examples/input.json --cert out.json
```

安装为命令后亦可直接使用 `settle run ...` / `settle verify ...`。

输入 `input.json` 含账户流水与规则哈希：

```json
{
  "rules_hash": "<rules.stl 的 sha256，不一致则拒绝执行>",
  "flows": [
    { "id": "t-001", "account": "acct-a", "amount": "1234.56", "date": "2026-10-01" }
  ]
}
```

证书 `out.json` 含：每笔费用/税额/净额（`results`）、`rules_hash`（规则源文件）、
`input_hash`（规范化输入）、`bytecode_hash`（整程序字节码）、`rule_hashes`
（逐规则字节码哈希，改一条规则只影响对应条目）与 `trace`（执行轨迹摘要：
指令数 + 轨迹摘要哈希）。

## 语言概览

```stl
// 注释支持 // 与 #
let fee_rate: rate = 0.0015;      // rate 字面量：最多 6 位小数
let min_fee: money = 0.01m;       // money 字面量：m 后缀，最多 2 位小数，禁止科学计数法
let effective: date = 2026-01-01; // date 字面量

rule fee(amount: money, day: date) -> money {
  let raw: money = round(amount * fee_rate);
  return if (day >= effective and raw < min_fee) then min_fee else raw;
}
```

- 类型：`money` / `rate` / `date` / `bool`，无隐式转换（如 `money + rate` 报 `E_TYPE`）。
- 运算：Pratt 解析，优先级 `or < and < ==/!= < 比较 < +/- < * < 一元 -/not`，支持括号。
- 作用域：`let` 常量（同作用域重复声明报 `E_SCOPE`）、规则参数遮蔽外层 `let`、
  未绑定变量报 `E_SCOPE`。
- 负税率（对 rate 取负）报 `E_TYPE`；金额内部以分（整数）运算，乘费率后四舍五入
  （half away from zero）到分。
- CLI 约定规则文件须定义 `fee` / `tax` / `net` 三个 `(money, date) -> money` 规则。

## 错误约定

词法/语法/类型/作用域/运行时错误分别以 `E_LEX` / `E_PARSE` / `E_TYPE` /
`E_SCOPE` / `E_RT` 输出到 stderr，JSON 含 `code`、`message`、`line`、`col`，
退出码非零，例如：

```json
{"code":"E_LEX","message":"money literal '1.005m' has more than 2 decimal places","line":1,"col":16}
```

## 代码结构

- `src/lexer.js` 词法分析；`src/parser.js` Pratt 解析；`src/types.js` 类型与作用域检查
- `src/compiler.js` 字节码编译；`src/vm.js` 栈式 VM（BigInt 定点运算）
- `src/cli.js` / `bin/settle.js` CLI；`src/hash.js` 规范化 JSON + sha256
- `examples/` 示例规则与输入；`test/` node:test 测试
