# netdsl — 交易所会员净额轧差 DSL 与 CLI

Node.js 22，仅标准库，无第三方依赖。单机离线运行。

## 快速开始

```sh
node bin/net run examples/rules.net examples/obs.json --proof proof.json
node --test
```

## DSL 概览

```
const FEE_RATE = 0.5%;            // 全局常量，所有作用域可见

day 2026-10-04 {                  // 按交易日划分的作用域
  const LIMIT = 1000000 USD;      // 仅本日可见；跨日引用 -> E_PARSE
  filter currency == USD and amount >= 100;
  nettable = min(amount, LIMIT) - amount * FEE_RATE;
  expect cycle @M1 -> @M2 -> @M3; // 声明必须出现在最优解中的环
}
```

- **词法**：会员 `@M1`、币种 `USD`（3 大写字母）、obligation id `#O1`、
  百分比 `2.5%`（基点整数，最多两位小数，禁止浮点）、日期、整数分、字符串。
- **Pratt 解析**：`or/and/==/!=/</<=/>/>=/+/-/*//`、一元 `-/not`，
  前缀函数 `min(a,b)`、`max(a,b)`、`abs(x)`、`net(x)`。
- **静态类型**：`int / pct / money<ccy,phase> / str / member / bool`。
  不同币种相加（如 `1 USD + 2 EUR`）编译期报 `E_CCY`；
  `nettable` 只接受 gross 金额，`net(...)` 的结果不能当毛额（`E_PARSE`）。
- **作用域**：`day` 块内常量只在该日可见；`day` 块的 filter/nettable
  覆盖全局定义；跨日引用报 `E_PARSE`。
- **编译为字节码**：表达式类型检查后代数化为栈机字节码
  （`PUSH_*/LOAD_FIELD/ADD/MUL/MIN/MAX/ABS/EQ/AND/NET/HALT` 等），
  由 VM 对每条 obligation 求值。全程手写解析器，无 `eval`/`Function`，
  规则表达式不可注入。
- **金额**：内部全部 `BigInt` 整数分；百分比为基点整数，
  `amount * 2.5% = amount * 250 / 10000`（整数除法）。

## 求解

1. 过滤后的 obligation 按币种聚合成有向债务图（同向边合并）。
2. 枚举全部简单环并规范化（**canonical cycle**：旋转到最小会员 id 开头，
   旋转等价去重）。
3. DFS + 记忆化搜索所有环抵消序列，求最小结算额 `minCash`；
   净头寸（每家 流入-流出）在抵消下保持不变。
4. 收集**全部**达到 minCash 的并列最优解（按 canonical 环集合去重），
   输出顺序确定（按签名排序）。超过 1000 个解时截断并在 proof 标记。

## proof.json

每个币种一节：`gross`、`minCash`、`netPositions`、`solutions[]`。
每个解列出 `cycles[]`（canonical 环 + 抵消金额，每一元抵消都能对应到具体环）
与 `residual[]`（剩余边）。引擎在输出前自检：
残余图的净头寸等于原净头寸，且 `gross - Σ环抵消 = residualTotal`。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_CCY` | 不同币种金额相加/比较（静态或运行时） |
| `E_CYCLE_DUP` | `expect cycle` 声明了旋转等价的重复环 |
| `E_NO_SOL` | 规则未选中任何 obligation、期望环不存在、除零、负净额 |
| `E_PARSE` | 词法/语法/类型/作用域/输入校验错误（含跨日引用、净额当毛额） |

## 目录

- `src/lexer.js` 词法；`src/parser.js` Pratt 解析 + 作用域
- `src/bytecode.js` 类型检查、字节码编译与 VM
- `src/graph.js` 债务图、canonical cycle、净头寸
- `src/solver.js` 最小结算额与全部并列最优解
- `src/engine.js` 管线与 proof 生成；`src/cli.js` + `bin/net` CLI
