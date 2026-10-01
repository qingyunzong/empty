# rgroup — 复制组模拟器（≤7 节点，epoch 配置 + 联合共识）

纯 Python 3.11 标准库实现，无第三方依赖。

## 语义

1. 每个已提交配置的 epoch 唯一且单调递增（初始 epoch=1，每次 `commit` +1）。
2. `begin_change(old, new)` 仅当 `old` 等于当前成员集合且没有进行中的变更时进入
   joint，否则报 `STALE_CONFIG`。
3. joint 阶段的写需要 old 与 new 各自多数派确认才提交。
4. `commit_change` 仅在 joint 成功后生效；`abort` 回滚到 old 配置，已确认写不丢失。
5. 未确认写只存在于内存，绝不落盘；已提交配置与已确认写在 tmp+fsync+rename 后
   才生效。故障点定义为配置记录 fsync 前崩溃（`failpoint=before_config_fsync`），
   恢复（`Group.load` / CLI `crash`）必须回到崩溃前已提交配置。

## CLI

```
python3 -m rgroup   # 从 stdin 读 JSON 行，向 stdout 写 JSON 行；任何错误 exit=6
```

状态目录由环境变量 `RGROUP_HOME` 指定（默认 `./.rgroup`）。

命令：`init`、`propose`、`ack`、`write`、`read`、`begin`、`commit`、`abort`，
另有辅助命令 `crash`（丢弃内存、从磁盘恢复）与 `status`。

示例：

```
{"cmd":"init","nodes":["a","b","c"]}
{"cmd":"write","value":"hello","node":"a"}
{"cmd":"ack","id":1,"node":"b"}
{"cmd":"begin","old":["a","b","c"],"new":["a","d","e"]}
{"cmd":"commit"}
{"cmd":"read"}
```

错误响应形如 `{"ok":false,"error":"STALE_CONFIG","message":"..."}`，进程退出码 6。

## 测试

```
python3 -m unittest discover -s tests -v
```

覆盖验收点：A 枚举 ≤5 节点全部多数派子集验证法定人数（含两两相交性、
提交阈值精确性）；B 旧 epoch 写/ack 被拒绝；C joint 中仅新配置多数派不得提交；
D fsync 前崩溃恢复后 epoch 与已提交写一致。
