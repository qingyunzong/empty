# incdel 实现与验收结果

持久化倒排索引：数据分 segment，删除只写 tombstone，merge 物理清除。
纯 Python 标准库（兼容 3.11+），无第三方依赖。

## 文件

- `incdel.py` — 索引库 + CLI（`add/del/commit/search/merge/dump`）
- `test_incdel.py` — unittest 套件（13 个用例）
- `RESULTS.md` — 本文件，记录真实运行输出

## 设计要点

**Commit 协议（固定顺序）**：写 tmp segment → fsync → rename 为正式 segment →
写 `manifest.tmp` → fsync → 原子 rename 为 `manifest.json`（提交点）→ fsync 目录。

**故障注入点**（`INCDEL_FAIL_AT` 环境变量或 `arm_fault()`，一次性触发，
CLI 以 `os._exit(99)` 模拟硬崩溃、不做任何清理）：

- `before_rename` — manifest.tmp 已 fsync、原子 rename 之前
- `after_rename` — 原子 rename 之后、目录 fsync 之前
- `merge_mid` — merge 的新 manifest 已提交、正在逐个删除旧 segment 文件的中段

**恢复规则**：加载时若发现崩溃证据（`manifest.tmp` 残留、`.seg.tmp` 残留、
磁盘上存在 manifest 未引用的孤儿 segment、或 manifest 引用的 segment 缺失），
则回滚到最后一个完整 commit：删除 tmp 文件与孤儿 segment、丢弃未提交的
`pending.json`，并 fsync 目录。rename 前崩溃 → 旧 manifest 原样生效；
rename 后崩溃 → 新 manifest 已生效，直接呈现新状态；merge 中段崩溃 →
新 manifest 已指向合并后的单个 segment，旧 segment 全部作为孤儿清理，
绝不出现半新半旧。

**可见性**：每条 add/del 分配全局单调 `seq`；同一 id 取 seq 最大的版本，
tombstone 的 seq 更大则隐藏，重新 add 同 id 后按最新版本可见。
merge 用当前可见集重写单个 segment 并清空 tombstone，被删记录物理消失。

**错误**：segment 文件带 SHA-256 校验和，损坏可识别 → 跳过并记 warning；
manifest 损坏 → exit 4；查询语法错（空查询或含非 `[A-Za-z0-9_]` 词项）→ exit 3。

## A. unittest 运行结果（真实输出）

```
$ python3 -m unittest -v
test_cli_fault_injection_and_recovery ... ok
test_corrupt_manifest_exit4 ... ok
test_corrupt_segment_skipped_with_warning ... ok
test_crash_after_rename_new_state_visible ... ok
test_crash_before_rename_during_merge_keeps_old_state ... ok
test_crash_before_rename_rolls_back ... ok
test_crash_merge_mid_no_partial_state ... ok
test_delete_nonexistent_id_then_add ... ok
test_duplicate_add_latest_wins ... ok
test_empty_commit_and_merge ... ok
test_merge_preserves_results ... ok
test_query_syntax_exit3 ... ok
test_readd_after_delete_recovery_and_merge ... ok

----------------------------------------------------------------------
Ran 13 tests in 1.365s

OK
```

覆盖验收项：

- **A 三故障点**：`test_crash_before_rename_rolls_back`、
  `test_crash_after_rename_new_state_visible`、`test_crash_merge_mid_no_partial_state`
  均在注入崩溃后重开索引，与内存模型（`Model` 类）逐项对照；另验证回滚后
  无 tmp/孤儿文件残留、merge 后 tombstone 清空且被删 id 物理消失。
- **B 语义**：`test_delete_nonexistent_id_then_add`（删不存在 id 后再 add）、
  `test_duplicate_add_latest_wins`（重复 add 取最新）、
  `test_merge_preserves_results`（merge 前后查询结果一致）、
  `test_readd_after_delete_recovery_and_merge`（删后再 add，恢复与 merge 后均可见）。
- **C 空库**：`test_empty_commit_and_merge`（空库 commit/merge/search）。
- **错误**：`test_corrupt_segment_skipped_with_warning`、
  `test_corrupt_manifest_exit4`、`test_query_syntax_exit3`。
- **CLI 端到端**：`test_cli_fault_injection_and_recovery` 用子进程 +
  `INCDEL_FAIL_AT` 验证三个注入点（exit 99）及恢复后 `dump`/`search` 输出。

## B. CLI 故障注入实录（真实输出）

```
=== setup ===
$ python3 incdel.py --dir /tmp/incdel-demo-final add a 'hello world'
  (exit 0)
$ python3 incdel.py --dir /tmp/incdel-demo-final commit
  (exit 0)
$ python3 incdel.py --dir /tmp/incdel-demo-final add b 'second document'
  (exit 0)

=== fault point 1: before_rename ===
$ INCDEL_FAIL_AT=before_rename python3 incdel.py --dir /tmp/incdel-demo-final commit
CRASH: injected fault at before_rename
  (exit 99)
$ python3 incdel.py --dir /tmp/incdel-demo-final dump
a	hello world
  (exit 0)
$ ls /tmp/incdel-demo-final
manifest.json
seg_000000.seg
  (exit 0)

=== fault point 2: after_rename ===
$ python3 incdel.py --dir /tmp/incdel-demo-final add b 'second document'
  (exit 0)
$ INCDEL_FAIL_AT=after_rename python3 incdel.py --dir /tmp/incdel-demo-final commit
CRASH: injected fault at after_rename
  (exit 99)
$ python3 incdel.py --dir /tmp/incdel-demo-final dump
a	hello world
b	second document
  (exit 0)

=== fault point 3: merge_mid ===
$ python3 incdel.py --dir /tmp/incdel-demo-final del a
  (exit 0)
$ python3 incdel.py --dir /tmp/incdel-demo-final commit
  (exit 0)
$ INCDEL_FAIL_AT=merge_mid python3 incdel.py --dir /tmp/incdel-demo-final merge
CRASH: injected fault at merge_mid
  (exit 99)
$ python3 incdel.py --dir /tmp/incdel-demo-final dump
b	second document
  (exit 0)
$ ls /tmp/incdel-demo-final
manifest.json
seg_000003.seg
  (exit 0)
$ python3 incdel.py --dir /tmp/incdel-demo-final search second
b
  (exit 0)

=== errors ===
$ python3 incdel.py --dir /tmp/incdel-demo-final search '!!!'
error: bad query: invalid term: '!!!'
  (exit 3)
corrupting manifest...
$ python3 incdel.py --dir /tmp/incdel-demo-final search hello
error: manifest.json is unreadable or fails its checksum
  (exit 4)
```

结果解读：

1. **before_rename**：崩溃后恢复只呈现旧 commit（`a`），未提交的 `b` 被回滚，
   `pending.json` 与孤儿 segment 均被清理（`ls` 只剩旧 manifest 与旧 segment）。
2. **after_rename**：rename 已完成，恢复后新状态（`a`+`b`）直接可见。
3. **merge_mid**：merge 中断后恢复呈现完整新状态（仅 `b`，`a` 的 tombstone
   已物理生效），磁盘上只剩合并后的单个 segment，无半新半旧。
4. 查询语法错误 exit 3；manifest 损坏 exit 4。

## 复现

```
python3 -m unittest -v          # 全部测试
python3 incdel.py --dir D add id "some text"
python3 incdel.py --dir D del id
python3 incdel.py --dir D commit
python3 incdel.py --dir D search term1 term2
python3 incdel.py --dir D merge
python3 incdel.py --dir D dump
INCDEL_FAIL_AT=before_rename|after_rename|merge_mid python3 incdel.py --dir D commit
```
