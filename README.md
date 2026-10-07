# quota-dsl — 授信额度冻结 DSL

银行授信场景：客户经理用脚本临时冻结额度，风控要求冻结 / 解冻 / 扣减在嵌套审批
作用域内不能越权，且全部历史可回放。仅依赖 Node.js 22 标准库与 `node:test`。

## 命令

```bash
# 运行测试
node --test

# 编译策略、应用事件流、落盘状态（含事件溯源日志）
node bin/quota.js apply examples/script.qta examples/events.jsonl --out state.json

# 从 state.json 重放事件日志，校验最终三额一致
node bin/quota.js replay state.json
```

## DSL 概览（`script.qta`）

```
customer C0001;                        // 客户号：词法模式 [A-Z]+4~8 位数字
note /^[A-Z0-9-]{3,32}$/;              // 备注白名单：正则字面量

bucket working_capital {               // 额度桶
  limit 1000000;
  valid 2026-01-01 to 2027-12-31;      // 有效期：日期词法模式
}

approval HQ {                          // 审批作用域，可任意嵌套
  cap working_capital 800000;          // 本级冻结上限（内层只能更严）
  let buffer = 50000;                  // 只读常量；内层可 shadowing 覆盖
  reject freeze when amount > available(working_capital) - buffer;

  approval REGION {
    cap working_capital 400000;
    reject freeze when amount > 300000 unless note matches /^VIP-/;
    approval TEAM { cap working_capital 150000; }
  }
}
```

- **Pratt 解析**：`when`/`unless` 条件支持 `+ - * /`、比较、`and/or/not`、
  `matches /re/`，优先级 `or < and < 比较 < 加减 < 乘除 < 一元`。
- **静态类型**：`limit`/`frozen`/`available`/`used` 是不同kind，混合比较或
  运算（如把 `frozen(b)` 当可用额）编译期报 `E_TYPE`；纯数字字面量可与任何
  kind  unified。
- **词法作用域**：内层 `cap` 若大于外层同桶上限，编译期报 `E_SCOPE`；
  `let` 绑定只读，内层可 shadowing，任何赋值语句报 `E_SCOPE`。
- **编译到字节码**：每条 `reject` 规则编译为栈式字节码
  （`PUSH/LOAD_*/ADD/.../JZ/JNZ/REJECT`），由 VM 在事件上下文中执行。

## 事件流（`events.jsonl`，每行一个 JSON）

```json
{"type":"freeze","id":"F-001","ts":"...","customer":"C0001","bucket":"working_capital","amount":120000,"until":"2026-12-31","note":"REQ-1001","scope":["HQ","REGION","TEAM"]}
{"type":"unfreeze","id":"U-001","ts":"...","customer":"C0001","bucket":"b","amount":20000,"note":"REQ-2","freeze_id":"F-001"}
{"type":"debit","id":"D-001","ts":"...","customer":"C0001","bucket":"b","amount":30000,"note":"REQ-3","freeze_id":"F-001"}
{"type":"business_day","id":"BD-1","date":"2026-12-01"}
```

## 核心语义

- **全序判定**：所有事件按 `(ts, id)` 排序后应用；同额同时刻的两个冻结，
  id 字典序小者胜，另一个 `E_CAP`，结果与输入顺序无关。
- **不超可用**：冻结/扣减超过 available 整体拒绝（`E_CAP`），绝不部分扣减。
- **解冻**：只能释放冻结记录中未使用的部分（`amount - used`）。
- **到期**：冻结在 `until` 日 00:00 到期；`business_day` 事件按业务日批量
  释放所有已到期冻结的未用部分；到期后的操作报 `E_EXPIRED`。
- **事件溯源**：每个事件（含被拒绝的）连同结果写入 `state.json` 的 `log`，
  `quota replay` 重放日志并校验最终 `available/frozen/used` 三额一致。

## 错误码

| 代码 | 含义 |
| --- | --- |
| `E_SCOPE` | 越权：内层放大上限、未知作用域路径、非法赋值、客户号不符 |
| `E_TYPE` | 类型错误：limit/frozen/available 混用、未知桶/名字、非常量 let |
| `E_CAP` | 额度不足或非法金额（含负解冻），整体拒绝不部分扣减 |
| `E_EXPIRED` | 冻结已到期 / until 不在有效期 / 业务日已过期 |
| `E_NOTE` | 备注不匹配白名单正则 |

## 目录

```
src/lexer.js    词法器（客户号/日期/正则字面量等词法模式）
src/parser.js   Pratt 解析器
src/check.js    静态检查：作用域层级 + 类型分离
src/compile.js  AST -> 字节码策略
src/vm.js       守卫规则栈式 VM
src/engine.js   运行时：三额状态机 + 全序 + 到期批处理 + 事件溯源
src/cli.js      quota apply / replay
test/           node:test 测试（含随机事件流对照参考实现）
```
