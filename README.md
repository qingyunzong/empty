# quota-dsl — 银行授信额度冻结 DSL

客户经理用脚本临时冻结授信额度; 风控要求冻结/解冻/扣减在嵌套审批作用域里不能越权,
且全部历史可回放。仅依赖 Node.js 标准库 (Node 22+), 测试用 `node:test`。

## 命令

```bash
node --test                                          # 跑全部测试
./quota apply examples/script.qta examples/events.jsonl --out state.json
./quota replay state.json
```

(`./quota` 是 `node bin/quota.js` 的包装; 也可 `node bin/quota.js ...`。)

## 流水线

```
script.qta ──lexer──> tokens ──Pratt parser──> AST ──静态检查──> 字节码 ──VM──> 策略
events.jsonl ────────────────────────────────────────────────> 事件引擎 ──> state.json
state.json ──replay: 重新编译脚本 + 重放事件, 校验最终三额与日志一致
```

- `src/lexer.js` — 词法模式: 客户号 `C\d{4,}`、额度桶标识符、有效期日期 `YYYY-MM-DD`、
  正则式备注白名单 `/.../flags`(`/` 在 `note_whitelist`/`matches` 后识别为正则, 否则为除法)
- `src/parser.js` — Pratt 解析: `or < and < ==/!= < 比较/matches < +/- < */`, 前缀 `-`/`not`,
  语句级 `guard <op> when <expr> unless <expr>;`
- `src/check.js` — 静态类型与作用域检查
- `src/compiler.js` / `src/vm.js` — 编译到字节码, VM 执行脚本构建策略(桶三额 + 作用域树)
- `src/engine.js` — 事件溯源引擎: 全序排序、业务日批量到期、应用事件、回放校验
- `src/cli.js` / `bin/quota.js` — CLI

## DSL 速览

```
customer C1001;
note_whitelist /^REQ-[0-9]{4}$/;
bucket loan limit 1000000;          # 顶层声明额度桶
validity 2026-01-01 to 2026-12-31;  # 策略有效期(可选)

let max_single = 300000;            # let 只读; var 可 set(仅当前作用域)

scope branch {                      # 审批层级嵌套
  cap loan 800000;                  # 内层只能更严: 超过外层有效上限 -> E_SCOPE(静态)
  guard freeze when amount <= max_single;
  scope region {
    cap loan 500000;
    scope manager {
      cap loan 400000;
      guard freeze unless frozen("loan") >= 350000;
    }
  }
}
```

- 内层 `let` 同名是合法 shadowing(只读覆盖); `set` 外层变量或 `let` -> `E_SCOPE`
- 内建: `limit("b")` / `frozen("b")` / `available("b")`、guard 上下文里的 `amount`/`note`

## 静态类型

`limit` / `frozen` / `available` 是三种独立类型, 与 `number`/`string`/`bool`/`date`/`regex` 并列:

- 算术: 同种额度类型或额度×数字合法; 混合两种额度类型 -> `E_TYPE`
- 比较: 同上; `frozen("b") >= available("b")` -> `E_TYPE`(禁止把冻结额当可用额)
- `cap` 只接受 `limit` 类型或数字, 且必须可静态求值
- guard 子句必须是 `bool`

## 事件语义 (events.jsonl)

```json
{"id":"e1","ts":"2026-10-01T09:00:00Z","type":"freeze","bucket":"loan","amount":200000,"note":"REQ-0001","until":"2026-11-01","scope":"branch.region.manager"}
{"id":"e2","ts":"2026-10-02T09:00:00Z","type":"unfreeze","bucket":"loan","ref":"REQ-0001","amount":50000}
{"id":"e3","ts":"2026-10-02T10:00:00Z","type":"draw","bucket":"loan","ref":"REQ-0001","amount":30000}
{"id":"e4","ts":"2026-10-03T09:00:00Z","type":"debit","bucket":"loan","amount":10000,"scope":"branch"}
{"id":"t1","type":"tick","date":"2026-11-01"}
```

- **全序**: 事件按 `(ts, id, 行号)` 排序; 同额同时刻的两个冻结按确定性 tie-break, 只有一个成功
- **E_CAP 不部分扣减**: 冻结/扣减/动用超可用或超 cap 时整体拒绝, 状态不变
- **解冻只释放未使用冻结**: `released = min(amount, 冻结额 - 已动用 - 已释放)`
- **到期按业务日批量生效**: 进入新业务日时一次性结算所有 `until <= 当日` 的冻结,
  未使用部分释放回 available; 到期日 `00:00` 起该冻结已过期(`draw`/`unfreeze` -> `E_EXPIRED`)
- **作用域占用**: 冻结/扣减沿审批路径累计 `consumed`, 任一级超 `cap` -> `E_CAP`;
  未知作用域路径 -> `E_SCOPE`

## 错误码

| 码 | 含义 |
|---|---|
| `E_SCOPE` | 内层放大外层上限、越权赋值外层变量、未知审批作用域 |
| `E_TYPE` | 静态类型错误(如把 frozen 当 available) |
| `E_CAP` | 超可用/超 cap/非正金额(含负解冻), 均不部分扣减 |
| `E_EXPIRED` | 冻结已到期、事件超出策略有效期 |
| `E_NOTE` | 备注不匹配白名单正则、活动冻结备注重复 |
| `E_GUARD` | guard when/unless 拒绝 |
| `E_VALID` | 事件/声明格式错误 |

## state.json 与回放

`apply` 写出的 `state.json` 内嵌脚本源码与原始事件流(事件溯源);
`quota replay state.json` 重新编译脚本并重放全部事件, 校验 buckets/freezes/scopes/log
与保存状态一致, 被篡改时以非零码退出并指出不一致字段。

## 目录

```
src/       库源码(lexer/parser/check/compiler/vm/engine/cli)
bin/       quota CLI 入口
quota      CLI 包装脚本
examples/  示例脚本与事件流
test/      node:test 测试(作用域/类型/边界/并发/属性/CLI)
RESULTS.md 真实测试与 CLI 输出
```
