# corp-actions

证券结算公司行动（corporate actions）DSL + 编译器 + 结算 VM。仅 Node.js 标准库（Node 22），测试使用 `node:test`。

支持分红（dividend）、拆股（split）、要约（tender）三类公司行动；公告可撤回（reverse）与重述（restate），按除权日生效；冲正生成反向公司行动并保留全部历史，托管行可凭 ledger 对账持仓与现金。

## 快速开始

```sh
node bin/corp.js apply examples/actions.ca examples/lots.json --ledger
node bin/corp.js compile examples/actions.ca   #  dump 字节码
node --test                                     # 全量测试
```

CLI：`corp apply <actions.ca> <lots.json> [--ledger]`。错误以 `E_XXX: message` 输出到 stderr，退出码 1（用法错误为 2）。

## DSL

```
action S1 { security AAPL kind split ratio 1/2 exdate 2024-06-10 version 1 }
action D1 { security AAPL kind dividend cash $2.5 * (1 + 1) exdate 2024-06-10 version 2 }
action T1 { security MSFT kind tender cash $380 + $20/4 exdate 2024-08-01 version 1 }
apply D1
apply S1            # 连续 apply 组成批次：同证券按 (除权日, 公告版本, 内容哈希) 排序执行
sell AAPL 150 on 2024-06-20
reverse S1          # 撤回：生成反向公司行动 S1#rev1，不删历史
restate S1 { ratio 1/4 version 2 }   # 重述：版本必须递增，除权日不得提前
```

- 词法：证券标识符、比例/数字字面量、现金字面量 `$2.50`、股数字面量 `100sh`、除权日 `YYYY-MM-DD`、公告版本整数；`#` 注释。
- 表达式：Pratt 解析 `+ - * / ( )` 与一元负号（`* /` 优先于 `+ -`，左结合），用于比例与现金替代（cash-in-lieu）表达式。
- 静态类型：`num` / `shares` / `cash`。现金与股数混用（如 `$2.5 + 3sh`、`$2 * $3`）编译期报 `E_TYPE`；拆股比例必须是无量纲且 `0 < ratio < 1`（old:new，1/2 表示 1 股变 2 股），比例 > 1 的"拆股"报 `E_RATIO`。
- 作用域按证券隔离：每个 action 只作用于单一证券的 lot 簿；同一证券的多个行动按顺序组合。
- 拆股可选 `cashinlieu $P`：零碎股按该价格折现。

## 字节码与 VM

编译为可序列化字节码（`APPLY` / `SELL` / `REVERSE` / `RESTATE`），VM 维护持仓 lot 与现金账户，所有数量用 BigInt 精确分数运算。

- **APPLY**：除权日前（`acquired < exdate`）持有的 lot 生效。split 按比例放大；dividend 按股派现；tender 以现金收购全部合格股。
- **REVERSE**：生成反向公司行动（如 `S1#rev1`）追加到账簿，历史条目不删除。拆股冲正按 FIFO 回溯受影响 lot；已卖出部分的不足额记应收/应付（receivable 负数 = 应付），持仓绝不为负。现金变动全额反向。
- **RESTATED**：旧版本仍生效时先冲正再按新版本生效；已撤回的公告直接按新版本生效。重述只影响除权日之后（作为新的账簿条目前向生效，不回溯改写历史），且新除权日不得早于原除权日（`E_DATE`）。
- 同证券同除权日的多个行动按公告版本排序，同版本按内容 SHA-256 哈希 tie-break，保证确定性。

## lots.json

```json
{ "cash": "1000", "lots": [ { "id": "L1", "security": "AAPL", "qty": "100", "date": "2024-01-05" } ] }
```

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_LOT` | 卖出超过持仓、非法 lot 数据 |
| `E_RATIO` | 非法比例（拆股 ratio 不在 (0,1)、比例类型错误） |
| `E_DATE` | 非法日期、重述把除权日提前 |
| `E_REVERSE` | 重复冲正、冲正未生效行动、重述版本未递增等 |
| `E_TYPE` | 现金与股数混用、字段类型错误 |
| `E_PARSE` / `E_ACTION` | 语法错误 / 行动声明或引用错误 |

## 目录

```
src/lexer.js     词法器        src/compiler.js  AST -> 字节码（含排序）
src/parser.js    Pratt 解析    src/vm.js        结算 VM（lot/现金/账簿）
src/types.js     静态类型      src/report.js    ledger/持仓输出
src/fraction.js  精确分数      bin/corp.js      CLI
test/            node:test 测试（含随机 FIFO 对照）
```
