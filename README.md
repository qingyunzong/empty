# event-merger

带历史分支的事件合并器。面向离线维护终端：同时确认（ack）、注释（note）、
撤回（deleted）设备事件并修订其因果依赖（dependsOn），三方合并后既保留
撤回痕迹，也能解释新增的因果冲突。纯 Node.js 22 标准库，无第三方依赖。

## 模型

- 事件：不可变 `id`，字段 `ts`(整数) / `source` / `type` / `ackBy` / `note` /
  `deleted` / `dependsOn`(id 集合)。`dependsOn: [t]` 表示 `t` 必须先于本事件。
- 每个输入分支（base/local/remote）加载时校验：引用必须存在、依赖图无环。
- 撤回事件保留全部元数据和边；执行投影只显示未撤回事件；未撤回事件直接
  依赖已撤回事件时产生 `BLOCKED` 报告，依赖边不会被偷偷删除。

## 合并语义（src/merge.js）

- 按事件 id、逐字段三方合并；不同字段的变更自动组合；同一标量双侧不同
  修改产生 `FIELD` 冲突（记录 base/local/remote 三方版本）。
- `dependsOn` 按逐条边的三方存在性合并（一侧删除边即删除，任一侧新增即保留）。
- 一侧 `deleted: false→true` 而另一侧修改了其他字段或依赖时产生
  `DELETE_UPDATE` 冲突（`deleted` 与所有被触及字段都成为待裁决字段）；
  双侧撤回可直接合并。
- 各分支各自合法，合并图仍可能成环：报告一条可核验的有向环，环上每条边
  标注来源分支（`addedBy` / `presentIn`），不用时间戳排序掩盖因果错误。
- 无环时用 Kahn 拓扑序，每轮从就绪候选中取 `(ts, id)` 最小者；时间戳只用于
  并列裁决，不要求沿因果边递增。

## resolution 与增量更新（src/repo.js）

- `resolve` 携带 `conflictId`、`field`、`choice: local|remote` 以及双方源版本
  前置条件 `expect: {local, remote}`；前置条件不匹配则拒绝（`PRECONDITION_FAILED`）。
- 每次选择立即增量更新：受影响依赖区域的 BLOCKED 状态（变更事件及其直接
  后继）与可重放拓扑证书被重新生成，其余未解决冲突保持不变。
- 源分支变化后重新合并时，仅仍满足源版本前置条件的选择沿用为 `ACTIVE`，
  其余标记为 `STALE_RESOLUTION`，对应冲突重新打开。

## 快照、差分与逆差分

- `mergeCommit` 仅在全部冲突解决且图合法（无环、无悬空引用）时，原子发布
  一个深度冻结的不可变快照（含父版本、输入分支、拓扑证书、BLOCKED 报告）。
- `diff(from, to)` 给出事件级差分；`inverseDiff(old, new)` 给出逆差分。
- `applyInverseDiff` 先校验前像匹配当前快照，应用后验证后像哈希
  （`postImageHash`）；任何失败都不改变历史与索引。

## 独立检查器（src/checker.js）

不复用合并器代码路径，独立核对：证书包含且仅包含全部事件、每条依赖边的
先后顺序、逐轮候选集合与 `(ts, id)` 最小选择、以及冲突来源（用独立的逐字段
合并重算冲突及三方版本）。

## JSONL CLI

`node cli.js`：stdin 每行一个 JSON 命令，stdout 每行一个 JSON 响应
（`{ok:true,...}` 或 `{ok:false,error,code}`）。

| op | 说明 |
| --- | --- |
| `init` | 重置仓库 |
| `loadBranch` `{name, events}` | 校验并加载 base/local/remote 分支 |
| `merge` | 三方合并，重估 resolution，返回冲突/环/阻塞/拓扑序 |
| `resolve` `{conflictId, field, choice, expect}` | 明确字段选择并增量更新 |
| `status` / `projection` / `certificate` | 状态、执行投影、拓扑证书 |
| `mergeCommit` | 原子写入不可变快照 |
| `snapshot` / `history` | 读取快照与历史 |
| `diff` / `inverseDiff` `{from, to}` | 差分 / 逆差分 |
| `applyInverseDiff` `{diff}` | 验证后像哈希后回滚索引 |
| `checkCertificate` `{snapshotId?}` | 独立核对当前合并或已提交快照 |

示例：

```sh
printf '%s\n' \
  '{"op":"loadBranch","name":"base","events":[{"id":"a","ts":1,"source":"t","type":"reading"}]}' \
  '{"op":"loadBranch","name":"local","events":[{"id":"a","ts":1,"source":"t","type":"reading","note":"x"}]}' \
  '{"op":"loadBranch","name":"remote","events":[{"id":"a","ts":1,"source":"t","type":"reading","note":"y"}]}' \
  '{"op":"merge"}' \
  '{"op":"resolve","conflictId":"field:a:note","field":"note","choice":"local","expect":{"local":"x","remote":"y"}}' \
  '{"op":"mergeCommit"}' | node cli.js
```

## 测试

`node --test`（node:test，28 个子测试全部通过）：

- `test/merge.test.js`（10）：分支校验（悬空引用/环）、字段组合与标量冲突、
  逐边依赖合并、DELETE_UPDATE、双侧撤回、跨分支加边成环及边来源、
  撤回保留元数据与 BLOCKED。
- `test/topo.test.js`（8）：时间倒退的合法因果链、时间戳仅作并列裁决、
  n≤7 枚举全部拓扑序验证确定性（Kahn 结果等于 (ts,id) 字典序最小拓扑序）、
  独立检查器接受合法证书并拒绝缺事件/乱序边/非最小候选/伪造冲突来源。
- `test/repo.test.js`（8）：resolve 前置条件与增量更新（与全图重算逐字段
  核对）、解除阻塞后的净差分、STALE_RESOLUTION、原子提交、快照不可变性、
  逆差分后像哈希验证失败不改历史、DELETE_UPDATE 解除后恢复依赖。
- `test/cli.test.js`（2）：JSONL 端到端会话与非法输入报告。
  （本沙箱嵌套 node 的管道 stdio 会丢数据，CLI 测试通过 FIFO + 文件重定向驱动。）

最近一次运行：`node --test` → tests 5, pass 5, fail 0（5 个测试文件，28 个子测试）。
