# ssi — 简化的可串行化快照隔离（SSI）

纯 Python 3.11+ 标准库实现的可串行化快照隔离引擎，附 JSON 行协议 CLI、
参考可串行化判定器与穷举对照测试。

## 语义

1. **读集 / 写集**：每个事务记录自己读过的键（`read_set`）与写缓冲
   （`write_set`）。
2. **并发定义**：两事务的快照区间 `[begin_ts, commit_ts]` 有重叠才算并发。
3. **写写冲突**：并发事务写同一键时按 first-committer-wins 处理，
   后提交者中止并返回 `WRITE_CONFLICT`。
4. **危险结构检测**：提交时，在"已提交的并发事务 + 当前事务"上构建
   rw 反依赖图（U 读到 V 写的键且二者并发 ⇒ 边 U→V）。若当前事务的
   提交会闭合一个冲突环（如 T1 读的键被 T2 写、T2 读的键被 T1 写），
   则中止当前提交者，返回 `SERIALIZATION_FAILURE`。
5. **只读事务**：永不中止，提交总是成功。

## 布局

- `ssi/core.py` — 引擎：`Engine` / `Transaction`，提交时冲突检测。
- `ssi/reference.py` — 参考判定器：构建 wr / rw / ww 依赖边，枚举全部
  串行序，存在满足所有依赖边的串行序即可串行化。
- `ssi/cli.py` / `ssi/__main__.py` — JSON 行协议 CLI（`python -m ssi`）。
- `tests/test_ssi.py` — 验收测试 a–d 及 CLI 测试。

## CLI 协议

每行一个 JSON 命令，每行返回一个 JSON 响应：

```
{"cmd":"begin","tx":"A"}                 -> {"ok":true,"tx":"A","snapshot":1}
{"cmd":"read","tx":"A","key":"x"}        -> {"ok":true,"value":null}
{"cmd":"write","tx":"A","key":"y","value":1} -> {"ok":true}
{"cmd":"commit","tx":"A"}                -> {"ok":true,"committed":true}
                                           或 {"ok":false,"committed":false,
                                               "error":"SERIALIZATION_FAILURE"|"WRITE_CONFLICT"}
{"cmd":"abort","tx":"A"}                 -> {"ok":true}
{"cmd":"dump"}                           -> {"ok":true,"store":{...}}
```

经典写偏序示例（A 读 x 写 y，B 读 y 写 x，实际运行输出）：

```
$ printf '%s\n' \
  '{"cmd":"begin","tx":"A"}' '{"cmd":"begin","tx":"B"}' \
  '{"cmd":"read","tx":"A","key":"x"}' '{"cmd":"read","tx":"B","key":"y"}' \
  '{"cmd":"write","tx":"A","key":"y","value":1}' \
  '{"cmd":"write","tx":"B","key":"x","value":2}' \
  '{"cmd":"commit","tx":"A"}' '{"cmd":"commit","tx":"B"}' | python3 -m ssi
{"ok": true, "tx": "A", "snapshot": 1}
{"ok": true, "tx": "B", "snapshot": 2}
{"ok": true, "value": null}
{"ok": true, "value": null}
{"ok": true}
{"ok": true}
{"ok": true, "committed": true}
{"ok": false, "committed": false, "error": "SERIALIZATION_FAILURE"}
```

## 测试

运行：

```
python -m unittest discover -s tests -v
```

覆盖验收项：

- **a)** 经典写偏序（两种提交顺序）必有一方 `SERIALIZATION_FAILURE`，且恰好一方中止。
- **b)** 无冲突并发事务全部提交成功。
- **c)** 只读事务与写事务并发（两种提交顺序、含 rw 反依赖）均不被中止。
- **d)** 穷举对照：两事务、每事务 0–3 个操作（读/写 × 键 x/y，共 85 种操作
  序列），85² × 2 种提交顺序 = 14450 个场景，逐一比对引擎的中止决策与参考
  判定器（枚举全部串行序）：写写冲突 ⇒ `WRITE_CONFLICT`；参考判定不可
  串行化 ⇒ 恰好后提交者 `SERIALIZATION_FAILURE`；否则双方成功。同时断言
  每个场景已提交集合按参考判定器可串行化。

## 真实测试结果

环境：Python 3.14.4（向后兼容 3.11 标准库）。2026-10-01 实际运行：

```
$ python3 -m unittest discover -s tests -v
test_error_responses (test_ssi.CLITest.test_error_responses) ... ok
test_write_skew_over_json_lines (test_ssi.CLITest.test_write_skew_over_json_lines) ... ok
test_disjoint_read_write_sets (test_ssi.ConflictFreeTest.test_disjoint_read_write_sets) ... ok
test_shared_read_only_key_disjoint_writes (test_ssi.ConflictFreeTest.test_shared_read_only_key_disjoint_writes) ... ok
test_all_small_scenarios (test_ssi.ExhaustiveComparisonTest.test_all_small_scenarios) ... ok
test_read_only_commits_before_and_after_writer (test_ssi.ReadOnlyTest.test_read_only_commits_before_and_after_writer) ... ok
test_read_only_never_aborts_even_with_rw_antidependency (test_ssi.ReadOnlyTest.test_read_only_never_aborts_even_with_rw_antidependency) ... ok
test_snapshot_reads_and_read_own_writes (test_ssi.SnapshotTest.test_snapshot_reads_and_read_own_writes) ... ok
test_concurrent_writers_same_key (test_ssi.WriteConflictTest.test_concurrent_writers_same_key) ... ok
test_sequential_writers_no_conflict (test_ssi.WriteConflictTest.test_sequential_writers_no_conflict) ... ok
test_exactly_one_aborts (test_ssi.WriteSkewTest.test_exactly_one_aborts) ... ok
test_one_side_fails_with_serialization_failure (test_ssi.WriteSkewTest.test_one_side_fails_with_serialization_failure) ... ok

----------------------------------------------------------------------
Ran 12 tests in 1.529s

OK
```
