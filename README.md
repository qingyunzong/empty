# repligroup — ≤7 节点复制组模拟器

纯 Python 3.11 标准库实现（无第三方依赖），模拟带 epoch 配置与两阶段成员变更的复制组。

## 语义

1. **epoch 唯一且递增**：每个配置（稳定或 joint）分配全局单调计数器上的新 epoch；`abort` 不回溯计数器，杜绝 epoch 复用。
2. **begin_change(old, new)**：仅当 `old` 等于当前已提交成员集合且没有进行中的变更时进入 joint，否则报 `STALE_CONFIG`。
3. **joint 阶段写**：必须同时获得 old 与 new 各自多数派的 ack 才提交。
4. **commit_change / abort**：`commit` 仅在 joint 成功后生效（安装 new 配置并分配新 epoch）；`abort` 回滚到 old 配置，已确认写不丢失。
5. **崩溃恢复**：未确认写只存在于内存，绝不落盘；已提交写与配置记录经 `write → fsync → rename → dir fsync` 持久化。故障点定义为配置记录 fsync 前崩溃（设 `SIM_CRASH_BEFORE_CONFIG_FSYNC=1` 触发 `os._exit(2)`），恢复后回到崩溃前 committed 配置。

## CLI

`python -m repligroup` 从 stdin 读 JSON 行，向 stdout 写 JSON 行；任一命令出错则进程退出码为 6。

```json
{"cmd": "propose", "value": "v", "epoch": 1}   -> {"ok": true, "seq": 1, "epoch": 1}
{"cmd": "ack", "node": "n1", "seq": 1}         -> {"ok": true, "seq": 1, "committed": false}
{"cmd": "begin", "old": ["n1","n2","n3"], "new": ["n1","n2","n4"]}
{"cmd": "commit"}                              -> 安装 new 配置，新 epoch
{"cmd": "abort"}                               -> 回滚到 old 配置
{"cmd": "write", "value": "v"}                 -> propose + 全体 voter ack，直接提交
{"cmd": "read"}                                -> 当前值、epoch、成员、阶段
```

环境变量：`CLUSTER_DATA_DIR`（状态目录，默认 `./cluster_data`）、`CLUSTER_NODES`（初始成员，默认 `n1,n2,n3`）、`SIM_CRASH_BEFORE_CONFIG_FSYNC`（故障注入）。

## 布局

- `repligroup/core.py` — 状态机：epoch、quorum、joint、两阶段变更
- `repligroup/store.py` — 原子持久化与崩溃恢复
- `repligroup/__main__.py` — JSON 行 CLI
- `tests/` — 验收测试 A–D

## 测试结果（真实运行）

命令：`python -m unittest discover -s tests -v`

```
test_errors_exit_6 (test_crash.CliBasicsTest.test_errors_exit_6) ... ok
test_unknown_command_exit_6 (test_crash.CliBasicsTest.test_unknown_command_exit_6) ... ok
test_write_read_roundtrip_exit_zero (test_crash.CliBasicsTest.test_write_read_roundtrip_exit_zero) ... ok
test_committed_config_survives_restart (test_crash.CrashRecoveryTest.test_committed_config_survives_restart) ... ok
test_crash_before_config_fsync_recovers_committed_config (test_crash.CrashRecoveryTest.test_crash_before_config_fsync_recovers_committed_config) ... ok
test_unacknowledged_write_not_persisted (test_crash.CrashRecoveryTest.test_unacknowledged_write_not_persisted) ... ok
test_begin_with_stale_old_config_rejected (test_epoch.EpochMonotonicityTest.test_begin_with_stale_old_config_rejected) ... ok
test_epochs_unique_and_increasing_even_across_abort (test_epoch.EpochMonotonicityTest.test_epochs_unique_and_increasing_even_across_abort) ... ok
test_stale_epoch_ack_rejected_after_begin (test_epoch.EpochMonotonicityTest.test_stale_epoch_ack_rejected_after_begin) ... ok
test_stale_epoch_propose_rejected_after_begin (test_epoch.EpochMonotonicityTest.test_stale_epoch_propose_rejected_after_begin) ... ok
test_stale_epoch_propose_rejected_after_commit (test_epoch.EpochMonotonicityTest.test_stale_epoch_propose_rejected_after_commit) ... ok
test_abort_rolls_back_without_losing_committed_writes (test_joint.JointConsensusTest.test_abort_rolls_back_without_losing_committed_writes) ... ok
test_abort_without_joint_fails (test_joint.JointConsensusTest.test_abort_without_joint_fails) ... ok
test_begin_with_wrong_old_fails (test_joint.JointConsensusTest.test_begin_with_wrong_old_fails) ... ok
test_both_majorities_commit (test_joint.JointConsensusTest.test_both_majorities_commit) ... ok
test_commit_installs_new_config_with_fresh_epoch (test_joint.JointConsensusTest.test_commit_installs_new_config_with_fresh_epoch) ... ok
test_commit_without_joint_fails (test_joint.JointConsensusTest.test_commit_without_joint_fails) ... ok
test_double_begin_fails (test_joint.JointConsensusTest.test_double_begin_fails) ... ok
test_new_majority_alone_does_not_commit (test_joint.JointConsensusTest.test_new_majority_alone_does_not_commit) ... ok
test_non_voter_ack_rejected (test_joint.JointConsensusTest.test_non_voter_ack_rejected) ... ok
test_old_majority_alone_does_not_commit (test_joint.JointConsensusTest.test_old_majority_alone_does_not_commit) ... ok
test_any_two_majorities_intersect (test_quorum.MajoritySubsetsTest.test_any_two_majorities_intersect) ... ok
test_every_subset_commits_iff_majority (test_quorum.MajoritySubsetsTest.test_every_subset_commits_iff_majority) ... ok
test_majority_definition (test_quorum.MajoritySubsetsTest.test_majority_definition) ... ok

----------------------------------------------------------------------
Ran 24 tests in 1.887s

OK
```
