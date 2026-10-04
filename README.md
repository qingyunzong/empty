# quality-quarantine-control

质量隔离控制库及 CLI（Node.js 22，仅标准库，离线单机）。仓库按周期性质检窗口对物料批次做隔离，只有**在窗口内完成检验且未命中缺陷区间**的批次才可被发料消耗；发料按 FEFO（到期时刻并列时按批次 ID），扣减支持撤销与恢复；迟到检验更正会增量重算可发性，已发料不撤回，改为生成受影响下游证书。

## 运行

```sh
node --test                 # 运行测试（结果已记录到 test-results.txt）
node src/cli.js input.json  # 或 cat input.ndjson | node src/cli.js
```

输入为 JSON 数组或 JSON 行（NDJSON），每条命令输出一行 JSON；任一命令出错时进程退出码为 1，错误不中断后续命令。示例见 `examples/demo.ndjson`。

## 命令

- `config`：`timezones`（时区转换表，每区为 `{from, offsetMinutes}` 偏移段序列）、`window`（`zone` + `weekly` 周期规则 `{days:[0..6], start:"HH:MM", end:"HH:MM"}`，支持跨零点窗口 + `holidays` 节假日例外，按本地日期排除）、可选 `defects` 缺陷区间。
- `defects`：`{cmd:"defects", add:[[start,end],...]}` 追加缺陷区间。区间为左闭右开 `[start, end)`，边界接触不算重叠，零长度区间不含任何点、永不拦截。
- `receive` / `available` / `quarantine` / `release` / `scrap`：批次生命周期事件。`receive` 携带 `qty`、`expiry`、`span`（批次自身区间，用于缺陷命中判定）。
- `inspect`：`{batch, inspectedAt, passed, at?}`。`inspectedAt` 必须落在质检窗口内，否则报错；`inspectedAt` 早于已发生事件时视为迟到更正，增量重算该批次可发性，并对 `inspectedAt` 之后从该批次发料的历史订单生成 `AFFECTED_DOWNSTREAM_CERTIFICATE` 证书（不自动撤回）。
- `issue`：`{orderId?, qty, at}`，按 (expiry, batchId) FEFO 扣减，返回 `issueId` 与 `allocations`。
- `undo` / `restore`：按 `issueId` 撤销/恢复扣减；恢复若会导致负库存则报错。
- `issuable` / `status`：查询当前可发批次（FEFO 序）与全量状态。

## 错误码

`NEGATIVE_INVENTORY`（发料超可发库存/恢复导致负库存）、`UNKNOWN_BATCH`（未知批次）、`ILLEGAL_PERIOD`（非法周期：零长度窗口、非法时间/星期/节假日、未知时区等）、`OUTSIDE_WINDOW`（检验不在窗口内）、`UNKNOWN_ISSUE`、`INVALID_STATE`、`DUPLICATE_BATCH`、`INVALID_COMMAND`。

## 结构

- `src/timezone.js` 离线时区转换表（偏移段查找，UTC↔本地换算）
- `src/window.js` 周期窗口规则 + 节假日例外
- `src/intervals.js` 半透明开区间集合（归并 + 二分）与逐一枚举的参考算法
- `src/store.js` 事件状态机：批次生命周期、FEFO 发料、撤销/恢复、迟到检验增量重算与证书
- `src/cli.js` JSON 行 CLI
- `test/` node:test 测试，含三条验收：跨窗口 FEFO 与并列、迟到检验阻断两批次并证明历史订单、零长度缺陷接触边界不拦截（对照枚举每个候选批次的参考算法）
