# offline-scheduler

离线排产辅助工具：变更说明的位置索引（短语/近邻/时间窗查询）+ 与预算约束耦合的 undo/redo 栈。
Node.js 22，仅标准库，测试使用 `node:test`，单机离线。

## 结构

- `src/varint.js` — LEB128 varint 编解码
- `src/bitset.js` — 分块 bitset（32 位块），varint 压缩序列化
- `src/index.js` — 位置倒排索引；posting = varint docId 差分 + 分块 bitset 位置表，
  查询始终走压缩字节解码路径；支持 `phrase` / `near` / 任务时间窗过滤；`removeDocument` 后无假阳性
- `src/scheduler.js` — 任务（资源、起止、deadline）、冲突集、受影响任务集合、
  undo/redo 栈与预算耦合、并列最优放置（冲突数 → 资源数 → 延迟 → 字典序）
- `cli.js` — `plan` / `change` / `undo` / `redo` / `query`

## 语义

- 冲突：两任务共享资源且时间区间（半开）重叠。
- 受影响集合：与被变任务共享资源的全部任务（含自身）。
- 预算：`applyChange` / `undo` / `redo` 后重算受影响集合的延迟和
  （`max(0, end - deadline)`），超预算则操作失败且状态不变（`E_BUDGET`）。
- 错误码：`E_BUDGET`（超预算）、`E_CONFLICT`（放置仍有冲突 / 任务冲突）、
  `E_EMPTY`（空栈、空结果、缺计划）。

## CLI 用法

```sh
node cli.js plan plan.json                      # 加载 {budget, tasks:[{id,resources,start,end,deadline}]}
node cli.js plan --suggest --duration 2 --resources "R1,R2;R3" --window "0 10" [--deadline 6]
node cli.js change --task A --shift -3 --note "换模 后 延迟 两 小时"
node cli.js undo                                # 回滚一层；超预算则失败且状态不变
node cli.js redo
node cli.js query --phrase "换模 后 延迟" [--window "8 14"]
node cli.js query --near "换模 延迟 4"
node cli.js query --delete-note 1               # 删除变更说明，索引不再返回它
```

状态默认存于 `.sched-state.json`，可用 `--state <path>` 指定。

## 测试

```sh
node --test
```

验收覆盖：1) 枚举全部任务对对照冲突集；2) 短语+时间窗与暴力文本扫描对照；
3) 撤销触发预算失败（状态不变）后 redo 成功；4) 删除变更说明后压缩索引无假阳性。
