# qctl — 质量隔离控制库与 CLI

Node.js 22，仅标准库，离线运行。按周期性质检窗口对物料批次做隔离控制，
FEFO 发料，支持迟到检验更正的增量重算与受影响下游证书。

## 运行

```sh
node --test                 # 运行全部测试
./run-tests.sh              # 运行测试并把结果记录到 test-results.txt
node bin/qctl.js input.json # 或: ... < input.json，输出 JSON 行
```

输入为 JSON（数组 / 单对象 / JSONL），每条命令输出一行 JSON；
任一命令出错时退出码为 1，错误以 `{"ok":false,"error":{code,message}}` 行输出，
后续命令继续执行。

## 命令

- `configure`：`timezones`（时区→偏移分钟数或 `[{from, offsetMinutes}]` 转换表）、
  `rules`（周期规则：`kind: daily|weekly`、`weekday`、`start: "HH:MM"`、
  `durationMinutes`、`timezone`、可选 `validFrom/validTo`）、
  `holidays`（`cancel: [YYYY-MM-DD]` 取消窗口，`add` 增加临时窗口）。
- `receive`：`batch`、`qty`、`expiry`、`lot: [start, end)`（批次生产区间，左闭右开）。
- `event`：`type: available|quarantine|release|scrap`（接收→可用→隔离→放行/报废）。
- `inspect`：`time`（检验完成时刻，须落在质检窗口内才有效）、`defects`（不透明
  区间集合，左闭右开，边界接触不算重叠）、可选 `recordedAt`（迟到更正）。
- `issue`：`id`、`qty`、`time`。FEFO：先到期的批次先发；到期时刻相同按批次 ID。
  可发库存不足时报 `NEGATIVE_INVENTORY` 且不产生任何扣减。
- `undo` / `restore`：撤销 / 恢复一笔发料扣减（恢复导致负库存时报错）。
- `snapshot`：当前库存、可发性、发料单与证书。

## 语义要点

- 批次可发条件：状态为 available、剩余 > 0、最新有效检验在窗口内完成且
  其缺陷区间集合与批次 `lot` 区间不重叠（零长度缺陷为空集，永不重叠）。
- 迟到检验（`recordedAt` 晚于相关发料）若使批次失去可发资格：增量重算
  当时库存可发性（`recompute` 输出前后总量），已发料不自动撤回，而是为
  检验时刻之后消耗该批次的每笔已生效发料生成 `affected-downstream-certificate`。
- 错误码：`NEGATIVE_INVENTORY`（负库存）、`UNKNOWN_BATCH`（未知批次）、
  `ILLEGAL_PERIOD`（非法周期规则/节假日/时区）、`VALIDATION`、`INVALID_STATE`、
  `DUPLICATE_BATCH`、`DUPLICATE_ISSUE`、`UNKNOWN_ISSUE`。

## 结构

- `src/intervals.js` — 半开区间集：归一化、重叠判定、逐对枚举参考算法。
- `src/windows.js` — 周期规则 + 节假日例外 + 时区转换表 → UTC 质检窗口。
- `src/engine.js` — 批次账本：事件状态机、FEFO 发料、撤销/恢复、迟到重算与证书。
- `src/cli.js` / `bin/qctl.js` — JSON 进、JSON 行出。
- `test/` — node:test 验收测试（跨窗口 FEFO 及并列、迟到检验双批次停发与
  历史订单证书、零长度缺陷边界 + 参考算法对拍、窗口/时区/非法周期、CLI）。
