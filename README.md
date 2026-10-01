# secidx

行存储 `(pk, fields)`，支持在任意字段上创建唯一或非唯一二级索引，
索引项与数据在同一事务内提交。纯 Python 标准库实现（兼容 3.11+），
无第三方依赖。

## 语义

- **同事务提交**：索引项与行数据在同一事务内原子提交；任何时刻不会
  出现索引指向不存在的行、或行存在而索引缺失（测试中以"索引 == 对
  已提交数据全量重建"的不变式持续校验）。
- **唯一索引**：冲突时整个事务以 `UNIQUE_VIOLATION` 失败并回滚，无
  部分效果。冲突检测发生在写操作时（对已提交数据 + 本事务未提交写）
  以及 commit 时（对其他事务在此期间提交的冲突键、以及同 pk 的
  写-写冲突）。
- **隔离性**：未提交事务的索引项对其他事务不可见；本事务可见自己的
  未提交写入，唯一性检查计入自己的未提交写入。
- **delete / update**：delete 同步移除索引项；update 等价于删旧插新。
- 字段缺失或值为 JSON `null` 的行不进入索引（类似 SQL 的 NULL 语义），
  因此也不参与唯一约束。

## CLI

`python -m secidx` 从 stdin 读 JSON 行协议，每行一个命令，stdout 每行
返回一个 JSON 响应。

```json
{"op": "begin"}                                  -> {"ok": true, "txn": 1}
{"op": "commit", "txn": 1}                       -> {"ok": true}
{"op": "abort",  "txn": 1}                       -> {"ok": true}
{"op": "create_index", "name": "by_email", "field": "email", "unique": true}
{"op": "insert", "txn": 1, "pk": "u1", "fields": {"email": "a@x", "age": 30}}
{"op": "update", "txn": 1, "pk": "u1", "fields": {"email": "b@x"}}
{"op": "delete", "txn": 1, "pk": "u1"}
{"op": "find", "index": "by_email", "key": "a@x", "txn": 1}
{"op": "scan", "index": "by_age", "start": 18, "end": 30}
```

- `find`/`scan` 的 `txn` 可省略（只读已提交状态）；`scan` 的
  `start`/`end` 可省略（全索引范围，按索引键排序，闭区间）。
- 错误响应：`{"ok": false, "error": "UNIQUE_VIOLATION", "message": ...}`；
  空结果查询返回 `{"ok": true, "rows": []}` 而非报错。

示例：

```
$ printf '%s\n' \
  '{"op":"create_index","name":"by_email","field":"email","unique":true}' \
  '{"op":"begin"}' \
  '{"op":"insert","txn":1,"pk":"u1","fields":{"email":"a@x"}}' \
  '{"op":"commit","txn":1}' \
  '{"op":"find","index":"by_email","key":"a@x"}' | python -m secidx
{"ok": true, "index": "by_email", "field": "email", "unique": true}
{"ok": true, "txn": 1}
{"ok": true}
{"ok": true}
{"ok": true, "rows": [{"pk": "u1", "fields": {"email": "a@x"}}]}
```

## 代码结构

- `secidx/store.py` — 存储引擎：事务、提交校验、索引维护、查询
- `secidx/cli.py` / `secidx/__main__.py` — JSON 行协议 CLI
- `tests/reference.py` — 暴力全表扫描的串行参考实现（差分测试用）
- `tests/test_*.py` — 单元测试、可见性/唯一性语义测试、CLI 测试、
  随机差分测试

## 测试

运行：`python -m unittest discover -s tests -v`

覆盖验收点：

- (a) 两事务交错插入同值唯一键，与串行参考实现结果一致
  （`test_unique.py`，先提交者胜，后者整体失败）
- (b) 事务 abort 后索引项完全消失（`test_visibility.py`）
- (c) update 后旧键查不到、新键可查（`test_store_basic.py`）
- (d) 空结果查询返回 `[]`（`test_store_basic.py` / `test_cli.py`）
- (e) 随机操作与暴力扫描参考实现比对（`test_random.py`，5 个种子 ×
  600 步多事务交错；另以 50 种子 × 1000 步压力验证零分歧）

### 真实测试结果（2026-10-01，Python 3.14.4）

```
$ python -m unittest discover -s tests -v
...
Ran 28 tests in 0.524s

OK
```

28 个测试全部通过（test_cli 5、test_random 1 含 5 种子、
test_store_basic 12、test_unique 5、test_visibility 5）。
