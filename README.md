# secidx

事务型行存储 `(pk, fields)`，支持在任意字段上创建唯一 / 非唯一二级索引。
纯 Python 标准库实现（兼容 Python 3.11+），无任何第三方依赖。

## 语义

- **索引与数据同事务提交**：索引项只在 `commit` 时与行数据一起落盘到已提交状态，
  任何时刻不会出现索引指向不存在的行、或行存在而索引缺失。
- **唯一索引冲突**：`insert`/`update` 触发唯一冲突时，整个事务立即以
  `UNIQUE_VIOLATION` 失败并整体回滚，不留任何部分效果（该事务此前的写入一并消失）。
- **隔离性**：未提交事务的索引项/行对其它事务不可见；但本事务可以看到自己的未提交写入，
  且唯一性检查计入自己的未提交写入（同事务内两行同键也会冲突）。
- **delete / update**：`delete` 同步移除该行的全部索引项；`update`（按字段合并）
  等价于删旧索引项 + 插新索引项。
- **并发模型**：first-writer-wins。事务在写入时预留其触及的唯一键与主键；
  并发事务撞同一唯一键立即得到 `UNIQUE_VIOLATION`，撞同一行得到 `TXN_CONFLICT`，
  因此交错执行等价于某个串行顺序（验收 a 的串行参考语义）。

## CLI：JSON 行协议

启动：`python3 -m secidx`（stdin 每行一个 JSON 命令，stdout 每行一个 JSON 响应）。

| 命令 | 字段 | 说明 |
|---|---|---|
| `begin` | `txn` | 开启事务 |
| `commit` / `abort` | `txn` | 提交 / 回滚 |
| `create_index` | `field`, `unique` | 在字段上建索引（`unique` 默认 `false`） |
| `insert` | `txn?`, `pk`, `fields` | 插入行 |
| `update` | `txn?`, `pk`, `fields` | 合并更新字段 |
| `delete` | `txn?`, `pk` | 删除行 |
| `find` | `txn?`, `field`, `value` | 等值查询（有索引走索引）；空结果返回 `[]` |
| `scan` | `txn?` | 全表扫描，按 pk 排序 |
| `reset` | — | 清空数据库 |

`txn` 省略时该命令在独立的自动提交事务中执行。
成功响应 `{"ok": true, ...}`；失败响应
`{"ok": false, "error": {"code": ..., "message": ...}}`，错误码包括
`UNIQUE_VIOLATION`、`TXN_CONFLICT`、`DUPLICATE_PK`、`NOT_FOUND`、`NO_SUCH_TXN`、
`TXN_EXISTS`、`INDEX_EXISTS`、`BAD_REQUEST`。

示例：

```
$ printf '%s\n' \
  '{"cmd":"create_index","field":"email","unique":true}' \
  '{"cmd":"insert","pk":1,"fields":{"email":"a@x"}}' \
  '{"cmd":"find","field":"email","value":"a@x"}' \
  '{"cmd":"find","field":"email","value":"nobody@x"}' | python3 -m secidx
{"ok": true}
{"ok": true}
{"ok": true, "rows": [{"pk": 1, "fields": {"email": "a@x"}}]}
{"ok": true, "rows": []}
```

## 代码结构

- `secidx/core.py` — `Database` / `Transaction` / `Index`，事务与索引核心逻辑
- `secidx/cli.py` — JSON 行协议 CLI（`python3 -m secidx`）
- `tests/test_secidx.py` — 核心语义测试（含验收 a–e 与随机比对）
- `tests/test_cli.py` — CLI 端到端测试（子进程 + 协议）

## 测试

运行：`python3 -m unittest discover -s tests -v`

覆盖验收标准：
- **a)** 两事务交错插入同值唯一键 → 负方立即 `UNIQUE_VIOLATION` 并整体回滚，
  提交结果与串行参考实现一致（两种交错顺序均测）；
- **b)** 事务 abort 后其索引项完全消失，唯一键可复用；
- **c)** update 字段后旧键查不到、新键可查；
- **d)** 空结果查询返回 `[]` 而非报错；
- **e)** 30 个随机种子 × 300 步随机操作，与暴力扫描参考实现逐查询比对
  （含错误类型一致性）。

### 真实测试结果（2026-10-01，Python 3.14.4）

```
$ python3 -m unittest discover -s tests -v
test_abort_then_update_semantics_over_cli (test_cli.CliTests.test_abort_then_update_semantics_over_cli) ... ok
test_basic_flow_and_empty_find (test_cli.CliTests.test_basic_flow_and_empty_find) ... ok
test_interleaved_unique_violation_over_cli (test_cli.CliTests.test_interleaved_unique_violation_over_cli) ... ok
test_malformed_input_and_unknown_command (test_cli.CliTests.test_malformed_input_and_unknown_command) ... ok
test_random_workloads_match_reference (test_secidx.RandomizedComparisonTest.test_random_workloads_match_reference) ... ok
test_abort_removes_index_entries (test_secidx.UniqueIndexTests.test_abort_removes_index_entries) ... ok
test_create_unique_index_over_duplicates_fails (test_secidx.UniqueIndexTests.test_create_unique_index_over_duplicates_fails) ... ok
test_delete_removes_index_entries (test_secidx.UniqueIndexTests.test_delete_removes_index_entries) ... ok
test_duplicate_pk_and_not_found (test_secidx.UniqueIndexTests.test_duplicate_pk_and_not_found) ... ok
test_empty_find_returns_empty_list (test_secidx.UniqueIndexTests.test_empty_find_returns_empty_list) ... ok
test_interleaved_unique_insert_matches_serial_reference (test_secidx.UniqueIndexTests.test_interleaved_unique_insert_matches_serial_reference) ... ok
test_interleaved_unique_insert_reverse_order (test_secidx.UniqueIndexTests.test_interleaved_unique_insert_reverse_order) ... ok
test_non_unique_index_returns_all_matches (test_secidx.UniqueIndexTests.test_non_unique_index_returns_all_matches) ... ok
test_row_level_write_conflict (test_secidx.UniqueIndexTests.test_row_level_write_conflict) ... ok
test_uncommitted_invisible_to_others_visible_to_self (test_secidx.UniqueIndexTests.test_uncommitted_invisible_to_others_visible_to_self) ... ok
test_unique_violation_rolls_back_whole_transaction (test_secidx.UniqueIndexTests.test_unique_violation_rolls_back_whole_transaction) ... ok
test_update_moves_index_entry (test_secidx.UniqueIndexTests.test_update_moves_index_entry) ... ok
test_update_unique_conflict_aborts_and_preserves_old_state (test_secidx.UniqueIndexTests.test_update_unique_conflict_aborts_and_preserves_old_state) ... ok

----------------------------------------------------------------------
Ran 18 tests in 1.499s

OK
```
