# je — 分录 DSL / Journal-Entry Engine

财务中台分录引擎：把业务事件编译成分录并批量入账。纯 Node.js 标准库实现，
无第三方依赖。夜间批处理可在任意 POST 写盘后宕机，`recover` 提供确定性恢复。

## 用法

```sh
je run batch.je events.json --db dir   # 编译并执行，写入 db 目录
je recover --db dir                    # 崩溃恢复：重放未入索引的 POST，修复索引
node --test                            # 运行测试
```

## DSL 概览

```
account 1001 "Cash";                  // 科目（词法：数字或标识符科目码）
period 2025-01 open;                  // 期间：open | closed
period 2024-12 closed;

template fee(rate) {                  // 模板：参数化、作用域隔离
  account FEE "Fee Payable";          // 模板科目仅在 use 它的批次内可见
  post dr 1001 (event.amount * rate) cr FEE (event.amount * rate);
}

batch SALE in 2025-01 on sale {       // 批次：按事件类型触发
  post dr 1001 event.amount cr 2001 event.amount;
  use fee(0.01);                      // 实例化模板（实例化参数）
  balance dr == cr;                   // 平衡条件（Pratt 解析，运行时断言）
}
```

- **词法**：科目码（整数/标识符）、`dr`/`cr` 借贷关键字、期间字面量（`2025-01`）、
  批次/模板/事件字段、字符串、注释。
- **Pratt 表达式**：`+ - * /`、一元负号、括号；平衡条件中可用 `dr`、`cr`、
  `dr(科目)`、`cr(科目)` 汇总量；优先级 `* /` 高于 `+ -`。
- **静态类型**：金额（Money，内部 1e-6 元整数单位）、科目、期间。
  编译期证明每个 `post` 借=贷（表达式规范化后逐项比对，支持常量折叠与
  交换律）；无法静态证明时要求批次内显式 `balance` 断言，否则 E_BALANCE。
  期间未声明或已关闭 → E_PERIOD（编译期）。模板参数按用法推断为
  科目/金额并校验实参。
- **作用域**：模板内声明的科目只在 `use` 它的批次作用域内可见，
  模板外引用 → E_SCOPE（禁止泄漏）。
- **编译与执行**：程序编译为字节码（`BEGIN_BATCH/PUSH/LOAD_EVENT/ADD../
  POST_ENTRY/LOAD_TOTAL/ASSERT_BALANCE/END_BATCH`），VM 按指令执行，
  维护内存账（账户 → 分），通过 DB 层落盘。

## 持久化与崩溃恢复

db 目录包含 `wal.log`（JSONL）、`postings.jsonl`（已落盘分录）、
`index.json`（余额索引 + 批次状态 + lastSeq）。

- WAL **仅**在三处写入：`BEGIN_BATCH`、每条 `POST` 前、`END_BATCH` 后。
- **崩溃点**：POST 写盘（postings.jsonl + fsync）后、索引更新前。
  注入方式：环境变量 `JE_CRASH_AT=post:<seq>`，进程以退出码 75 退出并
  打印 E_CRASH。
- **恢复**（`je recover`）：以 WAL 校验 postings 完整性（缺失/篡改 →
  E_REPLAY），把 `seq > index.lastSeq` 的分录重放进索引（修复索引），
  不多记（lastSeq 去重）不漏记（顺序重放）；重复执行幂等。
- 有 `BEGIN_BATCH` 无 `END_BATCH` 的批次状态为 **IN_FLIGHT**（未决），
  不等同失败；恢复不会把它补记为 POSTED。

## 错误码

| 码 | 含义 |
| --- | --- |
| E_BALANCE | 借贷不平衡（编译期无法证明且无断言 / 运行时断言失败 / 负金额） |
| E_PERIOD | 期间未声明或已关闭 |
| E_CRASH | 指定崩溃点触发的模拟宕机（退出码 75） |
| E_REPLAY | 恢复时 WAL 与 postings 不一致（缺记录、内容不符、序号空洞） |

（另有 E_PARSE / E_TYPE / E_SCOPE / E_EVENT / E_IO / E_USAGE 等辅助错误码。）

## 金额表示

DSL 与事件中的金额为元（十进制），内部以 1e-6 元整数单位运算，
POST 时四舍五入到分；账簿与索引以分（整数）存储，无浮点误差。
