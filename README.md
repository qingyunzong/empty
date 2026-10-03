# meteo-corrections

气象观测时间序列的增量更正库与 CLI。Node.js 22，仅标准库，全程离线。

## 模型

- **观测点**：`{t, v}`，按时间戳排序，时间戳唯一（重复返回 `E_TS`）。
- **派生节点**：滑动窗口 `{id, type: "mean"|"var", length}`，输出以窗口末端时间戳为键。
  窗口长度可通过 `setWindowLength` 修改，修改后该窗口的依赖关系整体重建。
- **更正事务**：`{targetTs, op: "set"|"offset"|"scale", value, reason, ts}`，
  必须携带 `reason` 与 `ts`（缺失返回 `E_INVALID`）。

## 行为

- 乱序送达的更正先按 `ts` 归位（稳定排序），再逐条应用。
- 每次更正只重算覆盖被改观测点的窗口输出（最小失效集合），返回：
  - `diff`：新旧值差分 `[{window, endTs, old, new}]`；
  - `affected`：受影响区间 `{from, to}`（无变化为 `null`）；
  - `certificate`：对 `{finalizeHorizon, observations, windows}` 规范序列化后的 SHA-256 确定性哈希。
- `targetTs < finalizeHorizon` 的观测拒绝更正，返回 `E_FINALIZED`；越界目标返回 `E_RANGE`。
- `undo()` / `redo()` 逐条回滚/重做；写入新更正时清空重做栈。
- 零长度窗口输出为空、空序列、越界更正均为稳定结果（不抛异常，返回错误码）。

## CLI

从 stdin 读取 JSON，向 stdout 写出 JSON：

```sh
echo '{"observations":[{"t":1,"v":1},{"t":2,"v":2}],
       "windows":[{"id":"m2","type":"mean","length":2}],
       "finalizeHorizon":0,
       "corrections":[{"targetTs":2,"op":"scale","value":3,"reason":"cal","ts":7}]}' | node cli.js
```

输入字段：`observations`、`windows`、`finalizeHorizon`、`corrections`（顶层数组，按 ts 归位后应用）、
`operations`（有序操作列表：`correct` / `undo` / `redo` / `setWindowLength` / `observe`）。

输出：`results`（每个操作的差分、受影响区间、证书）、`final`（最终观测与窗口输出）、
顶层 `certificate`。

## 测试

```sh
node --test > test-results.txt 2>&1
```

覆盖：≤12 点 / 3 窗口下增量结果与全序列枚举参考实现（`fullRecompute`）逐点对比及差分对比、
乱序更正归位与最小失效集合、越界/零窗口/撤销后重做/空序列等边界。
