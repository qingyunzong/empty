# je — 分录 DSL 编译器 / 字节码 VM / WAL 账本

财务中台夜间批处理：把业务事件编译成分录批量入账。单机、离线、仅 Node.js 22 标准库。

## 流水线

```
batch.je ──lex──▶ tokens ──Pratt parse──▶ AST ──static check──▶ typed AST
                                                              │
events.json ──────────────────────────────────────────────────┤
                                                              ▼
ledger ◀── WAL store ◀── POST ◀── stack VM ◀── bytecode ◀── compile
```

- `src/lexer.js` — 词法：`period`/`template`/`batch`/`debit`/`credit`/`balance`/`allow` 关键字、科目标识符、`$参数`、期间字符串、数字、运算符。
- `src/parser.js` — Pratt 解析器：金额表达式与平衡条件（`==` < `+ -` < `* /` < 一元 `-` < 括号）。
- `src/checker.js` — 静态类型：
  - 金额表达式归一化为符号多项式，证明 `debit == credit`（或模板内显式 `balance` 条件）对任意参数成立，否则 `E_BALANCE`；
  - 批次必须绑定已声明期间，否则 `E_PERIOD`（运行时再查关闭期间）；
  - 词法作用域：模板参数按使用位置推断为「科目」或「金额」种类，跨模板引用/未声明引用报 `E_SCOPE`，种类冲突报 `E_TYPE`，模板外无泄漏。
- `src/compiler.js` — 编译为栈式字节码（`PUSH_NUM/PUSH_ARG/PUSH_TOTAL/ADD/SUB/MUL/DIV/DEBIT/CREDIT/CHECK_BALANCE`）。
- `src/vm.js` — VM 按指令执行，维护内存账（`period|account -> balance`），每条事件结束触发 `POST`。
- `src/store.js` — 持久化与恢复（见下）。

## 持久化与崩溃恢复

WAL（`wal.log`）**仅**在三处写入：`BEGIN_BATCH`、每条 `POST` 之前、`END_BATCH` 之后。
写序：`WAL POST → posts.jsonl 落盘 → index.json 更新`。

**崩溃点定义**：POST 已写盘、索引尚未更新。恢复（`je recover`）从 WAL 重放该 POST：
若 `posts.jsonl` 缺失则补写，再修复索引（余额 + 帖子标记）。重放按帖子 id（`批次:序号`）幂等——
不双记、不漏记。`BEGIN` 后无 `END` 的批次保持 `IN_FLIGHT`（未决），**不**等同失败。
脏库（`dirty`）上的 `je run` 拒绝执行并报 `E_CRASH`，须先 `recover`。
WAL 损坏或 WAL 与盘面条目不一致报 `E_REPLAY`。

## CLI

```
je run <batch.je> <events.json> --db <dir>   # 编译并执行事件批次
je recover --db <dir>                        # 重放 WAL、修复索引、列出 IN_FLIGHT
je balances --db <dir> [--period <p>]        # 查看余额
je batches --db <dir>                        # 查看批次状态
je close-period <period> --db <dir>          # 关闭期间（再入账报 E_PERIOD）
```

## DSL 示例

```
period "2025-01"

template transfer(from, to, amount) {
  debit from $amount
  credit to $amount
  balance debit == credit        // Pratt 解析的平衡条件，静态证明
}

template sale(gross, fee) {      // 无显式条件时默认要求 debit == credit
  debit cash $gross
  credit revenue $gross - $fee
  credit fees $fee
}

batch B1 { period "2025-01" allow transfer, sale }
```

## 错误码

`E_BALANCE`（借贷不等）/ `E_PERIOD`（期间关闭或未声明）/ `E_CRASH`（脏库需恢复）/ `E_REPLAY`（WAL 重放冲突），
另有 `E_LEX/E_PARSE/E_SCOPE/E_TYPE/E_COMPILE/E_RUNTIME`。

## 测试

```
node --test
```

崩溃注入（测试用）：`JE_CRASH_AFTER_POST=N`（第 N 条 POST 写盘后、索引更新前退出 97）、
`JE_CRASH_AFTER_WAL=N`（WAL 写后、POST 写盘前）、`JE_CRASH_MODE=throw`（进程内等价模拟）。
