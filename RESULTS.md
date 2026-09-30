# incdel 验收结果（真实运行记录）

- 环境：Python 3.14.4（仅标准库，兼容 3.11），Linux，unittest + CLI 实测
- 日期：2026-10-01
- 故障注入方式：Python API 层 `Store(dir, crash_at=...)` 抛 `CrashError`；CLI 层环境变量 `INCDEL_CRASH_AT`，注入点可选值为 `pre_rename`（manifest 原子 rename 前）、`post_rename`（rename 后、目录 fsync 前）、`merge_mid`（merge 新 manifest 已生效、旧 segment 删除前）。

## 1. unittest 全量结果

```
$ python3 -m unittest -v
test_cli_corrupt_manifest_exit4 ... ok
test_cli_crash_injection_and_recovery ... ok
test_cli_empty_db ... ok
test_cli_happy_path ... ok
test_cli_query_syntax_error_exit3 ... ok
test_corrupt_manifest_raises ... ok
test_corrupt_segment_skipped_with_warning ... ok
test_empty_commit_and_merge ... ok
test_crash_merge_mid_no_half_state ... ok
test_crash_post_rename_exposes_new_state ... ok
test_crash_pre_rename_during_merge_keeps_old_segments ... ok
test_crash_pre_rename_rolls_back ... ok
test_delete_nonexistent_id ... ok
test_duplicate_add_latest_wins ... ok
test_merge_preserves_results ... ok
test_readd_after_delete_and_recovery ... ok
----------------------------------------------------------------------
Ran 16 tests in 1.167s

OK
```

覆盖映射：
- 验收 A（三故障点注入后恢复对照内存模型）：`TestFaultInjection` 4 个用例，逐一与 `Model`（内存 dict 参考实现）比对 `dump()` 与多个 `search()` 结果。
- 验收 B（删除不存在 id / 重复 add / merge 前后一致）：`TestSemantics` 4 个用例。
- 验收 C（空库 commit/merge）：`TestEmptyAndCorruption.test_empty_commit_and_merge` 与 `TestCLI.test_cli_empty_db`。
- 错误路径：损坏 segment 跳过+warn、损坏 manifest exit 4、查询语法错 exit 3。

## 2. CLI 故障注入实录

数据目录 `/tmp/incdel_demo1`，先建立两个 commit 的基线：

```
$ python3 incdel.py --dir /tmp/incdel_demo1 add a "the quick brown fox"
added a
$ python3 incdel.py --dir /tmp/incdel_demo1 add b "lazy dogs and quick cats"
added b
$ python3 incdel.py --dir /tmp/incdel_demo1 commit
committed
$ python3 incdel.py --dir /tmp/incdel_demo1 del a
deleted a
$ python3 incdel.py --dir /tmp/incdel_demo1 add c "quick brown hare"
added c
$ python3 incdel.py --dir /tmp/incdel_demo1 commit
committed
```

### 故障点 1：pre_rename（manifest 原子 rename 前崩溃）→ 回滚旧 manifest

```
$ python3 incdel.py --dir /tmp/incdel_demo1 add d "phantom doc"
added d
(exit 0)
$ INCDEL_CRASH_AT=pre_rename python3 incdel.py --dir /tmp/incdel_demo1 commit
crash injected at pre_rename
(exit 75)
--- recovery ---
$ python3 incdel.py --dir /tmp/incdel_demo1 dump
b	lazy dogs and quick cats
c	quick brown hare
(exit 0)
```

恢复后 `d` 不存在（未提交事务整体回滚），残留的新 segment 文件与 `manifest.tmp` 被恢复逻辑清除。

### 故障点 2：post_rename（rename 后、目录 fsync 前崩溃）→ 新状态可见

```
$ python3 incdel.py --dir /tmp/incdel_demo1 add d "now committed for real"
added d
(exit 0)
$ INCDEL_CRASH_AT=post_rename python3 incdel.py --dir /tmp/incdel_demo1 commit
crash injected at post_rename
(exit 75)
--- recovery ---
$ python3 incdel.py --dir /tmp/incdel_demo1 dump
b	lazy dogs and quick cats
c	quick brown hare
d	now committed for real
(exit 0)
```

rename 已发生即视为最后一个完整 commit，恢复后 `d` 可见；无 pending 日志重放导致的重复应用。

### 故障点 3：merge_mid（merge 中段崩溃）→ 无半新半旧

```
$ INCDEL_CRASH_AT=merge_mid python3 incdel.py --dir /tmp/incdel_demo1 merge
crash injected at merge_mid
(exit 75)
--- files right after crash ---
manifest.json  seg_000001.json  seg_000002.json  seg_000003.json  seg_000004.json
--- recovery ---
$ python3 incdel.py --dir /tmp/incdel_demo1 dump
b	lazy dogs and quick cats
c	quick brown hare
d	now committed for real
(exit 0)
$ python3 incdel.py --dir /tmp/incdel_demo1 search quick AND brown
c
(exit 0)
--- files after recovery ---
manifest.json  seg_000004.json
```

崩溃瞬间磁盘上新旧 segment 并存，但 manifest 原子指向完整的新集合；恢复时未被引用的旧 segment 被清除，逻辑视图自始至终一致。merge 可安全重试：

```
$ python3 incdel.py --dir /tmp/incdel_demo1 merge
merged
(exit 0)
```

## 3. 错误与边界实录

```
# 空库
$ python3 incdel.py --dir /tmp/incdel_demo2 commit
nothing to commit
(exit 0)
$ python3 incdel.py --dir /tmp/incdel_demo2 merge
nothing to merge
(exit 0)

# 损坏 segment：warn + 跳过（seg_000002.json 被手工写坏）
$ python3 incdel.py --dir /tmp/incdel_demo3 dump
warning: skipping corrupt segment seg_000002.json (Expecting property name enclosed in double quotes: line 1 column 2 (char 1))
good	clean doc
(exit 0)

# 查询语法错误 -> exit 3
$ python3 incdel.py --dir /tmp/incdel_demo2 search apple AND
error: bad query: dangling AND
(exit 3)
$ python3 incdel.py --dir /tmp/incdel_demo2 search
error: bad query: empty query
(exit 3)

# manifest 损坏 -> exit 4
$ python3 incdel.py --dir /tmp/incdel_demo2 search clean
error: corrupt manifest: Expecting value: line 1 column 1 (char 0)
(exit 4)
```

## 4. 语义结论

1. 删除仅写 tombstone（segment 内 `["del", id]` op），merge 后物理清除（合并 segment 只含 `add` op，已由 `test_merge_preserves_results` 断言）。
2. commit 顺序固定为：tmp segment → fsync → rename → manifest.tmp → fsync → 原子 rename → 目录 fsync（见 `incdel.py` `Store.commit` / `_commit_manifest`）。
3. 恢复只呈现最后一个完整 commit：pre_rename 崩溃回滚旧 manifest；post_rename 崩溃新状态可见；merge 中段崩溃不出现半新半旧（manifest 原子切换 segment 集合，恢复清理未引用文件）。
4. 已删 id 在恢复、merge、重新 add 同 id 后均按最新版本可见（`test_readd_after_delete_and_recovery`、`test_duplicate_add_latest_wins`）。
