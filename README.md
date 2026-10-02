# 工装寿命预约库与 CLI

Node.js 22，仅标准库 + `node:test`，离线单机运行。

## 模型

每套模具（mold）配置：

```json
{
  "id": "M1",
  "cycleMinutes": 300,              // 保养周期寿命上限（分钟）
  "maintenanceMinutes": 45,         // 单次保养时长
  "usedMinutes": 0,                 // 已累计使用分钟（可选，默认 0）
  "startTime": "2026-10-05T08:00:00Z",
  "calendar": {
    "workdays": ["2026-10-05"],     // 或 "weekdays": [1,2,3,4,5]；缺省每天工作
    "start": "08:00", "end": "17:00",          // 生产可用窗口
    "shifts": [["08:00", "09:00"]]             // 班次窗口：保养只能在其内进行
  },
  "resetIntervals": [["2026-10-07T00:00:00Z", "2026-10-08T00:00:00Z"]]  // 强制重置区间
}
```

- 工单加工必须落在日历可用窗口内（可跨窗口暂停续作）；强制重置区间占用时间且经过后寿命计数清零。
- 若加工后累计寿命超过 `cycleMinutes`，需先插入保养；保养只能放在班次窗口内、不与强制重置区间及其他保养重叠，保养后寿命清零。
- 队列重排采用分段动态规划：先最少保养次数，再最早全部完成（与枚举所有保养位置的对照算法解空间一致，见 `test/reference.js`）。

## 命令（JSON）

`addMold` / `book` / `move` / `cancel` / `correct` / `undo` / `state` / `schedule`。

- `book`：`order: {id, minutes, moldId?, candidates?, notBefore?}`；不指定模具时选最早完成、并列取模具 ID 最小者。
- `move`：`{orderId, moldId?, index?}`；不指定位置时搜索全部候选，选**调整最少**（其他工单开始时间变化数最小），并列选最早完成，再并列选模具 ID 最小。
- `correct`：`{orderId, deltaMinutes}` 增量更正加工时长并重排。
- `cancel`：取消工单并释放占用。
- `undo`：`{txId?}` 按工单事务撤销，恢复寿命与占用（缺省撤销最近一笔）。

## 持久化与故障点

状态存本地 JSON 文件。提交协议：先写 `<file>.tmp`，再 `rename` 覆盖正式文件——**rename 完成才算提交成功**。显式故障点为 `Store` 的写入钩子（`beforeTmpWrite` / `beforeRename` / `afterRename`），测试用 `beforeRename` 抛错模拟"写状态文件前崩溃"：旧文件保持可读且字节不变，内存态回滚，无半笔事务。

## 运行

```sh
node cli.js state.json << 'JSON'
[
  {"cmd":"addMold","mold":{"id":"M1","cycleMinutes":240,"maintenanceMinutes":30,
    "startTime":"2026-10-05T08:00:00Z",
    "calendar":{"workdays":["2026-10-05"],"start":"08:00","end":"17:00","shifts":[["12:00","13:00"]]}}},
  {"cmd":"book","order":{"id":"O1","minutes":200}},
  {"cmd":"state"}
]
JSON
```

每条命令输出一个 JSON 结果（`ok`/`error`），全部成功退出码为 0。

## 测试

```sh
node --test
```

验收覆盖：1) 两套模具各自触发不同保养且并行生产；2) 保养遇休息日顺延到下一班次窗口且工单顺序不变；3) 模拟 rename 前崩溃后旧文件可恢复、无半笔事务，并用枚举保养位置的小规模对照算法（含随机用例）交叉验证调度结果。
