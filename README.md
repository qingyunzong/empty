# obs-store

离线样本观测导入存储：支持 `put` / `correct`（更正）/ `delete`（删除留痕）/
`merge` / `status`，每条记录携带向量时钟（vector clock）与 lamport 时钟，
冲突裁决只用逻辑时钟，不使用物理时钟。

仅依赖 Node.js 22 标准库，测试使用 `node:test`。

## 数据模型

- 每个写操作产生一条事件：`{id, kind, key, value?, node, seq, vclock, lamport}`，
  追加到 `<dir>/events.log`。
- 可见性裁决：对每个 key 取 `(lamport, node, id)` 字典序最大的事件；
  若该事件是 `delete`，则 key 不可见（tombstone）。这是确定性全序，
  因此 merge 可交换、可结合、幂等（merge 即事件集合并，按 `id` 去重）。
- 两条历史的并发判断：比较其向量时钟，互不支配即为并发
  （`compareVclock` / `obs compare`）。

## Tombstone 与压缩

- `delete` 生成 tombstone 事件，删除留痕。
- 压缩（`obs compact`）仅在两个条件同时满足时移除 tombstone 及其因果覆盖的事件：
  1. 保留期已过：`now - tombstone.ts >= retentionMs`（参数化，`--retention-ms`）；
  2. 所有已知节点都已见过该 tombstone（每个节点的 knowledge 向量时钟覆盖它）。
- 被压缩的 tombstone 的向量时钟记录在 `meta.compacted`，
  之后任何被其覆盖的旧事件再次投递都会被拒绝，旧值不会复活。

## 崩溃原子性

日志按批追加：若干 `event` 行 + 一行 `commit`（含 batch id 与计数），
单次 `write` 后 `fsync`。重放时只应用有匹配 `commit` 的批；
kill 发生在 fsync 之前时，重启后该批要么整体可见、要么整体不可见。

## CLI

```sh
obs init --dir D --node N [--nodes a,b,c]
echo '{"key":"s1","value":{"temp":21.5}}' | obs put --dir D
echo '{"key":"s1","value":{"temp":22}}'   | obs correct --dir D
echo '{"key":"s1"}'                       | obs delete --dir D
obs merge --dir D --other OTHER_DIR      # 或从 stdin 读事件 JSON 行
obs status --dir D
obs compact --dir D [--now MS] [--retention-ms MS]
obs compare                              # stdin 两行向量时钟/事件 JSON
```

- 输入：JSON 行（stdin）；`put`/`correct`/`delete` 支持多行批量导入，整批原子生效。
- 输出：stdout 为 JSON（每行一个）。
- 错误：stderr 单行 `{"code","msg"}`，退出码非 0（操作错误 1，用法错误 2）。

错误码：`USAGE` `INVALID_INPUT` `STORE_EXISTS` `STORE_NOT_FOUND`
`STORE_CORRUPT` `KEY_EXISTS` `KEY_NOT_FOUND` `INTERNAL`。

## 测试

```sh
node --test
```

覆盖：三路并发更正的全排列参考一致性、删除不复活与压缩前后可见状态一致、
重复/乱序投递幂等、fsync 前 kill 的整批原子性（通过
`OBS_DEBUG_*` 故障注入钩子，仅测试使用）。
