# docstore — 持久 JSON 文档库

纯 Python 3.11 标准库实现，无第三方依赖。对嵌套 JSON 文档持续应用
JSON Patch 批次，并维护与快照查询一致的路径索引。

## 功能

- **路径索引**：模式段支持对象键、数组下标与通配符 `*`（可嵌套，如
  `/a/*/b/*`）。索引只收录标量叶子值。
- **查询**：等值过滤 `eq`、存在性 `exists`、合取 `and`，以及
  `sort_by` 按索引值排序（按词法类型分组：null < bool < int < float <
  string）。
- **词法类型区分**：整数 `1`、小数 `1.0`、布尔 `true` 是三种不同值，
  布尔绝不混为整数；严格 JSON 解析拒绝重复对象键与 NaN/Infinity。
- **JSON Patch**：`add/remove/replace/move/test/copy`，批次全有或全无；
  `move` 进自身子树（含自身）被拒绝。
- **增量索引维护**：数组插入/删除报告整个数组为受影响前缀（覆盖下标
  迁移），对象键与原地替换只报告叶子子树；父节点移动同时报告源与目标
  两侧。索引按代复制前进，绝不每次全量重建。
- **版本与快照**：每次提交产生不可变 `Version`；`open_snapshot()` 固定
  只读视图，`reclaim()` 截断日志不影响仍被引用的快照。
- **崩溃恢复**：WAL 采用 tmp+fsync+原子改名；`create_index` 先全量构建
  再通过日志补齐、原子切换；`reclaim` 先写 base 快照再截断。可注入
  中断点：`wal_tmp_written`、`wal_committed`、`after_publish`、
  `before_index_publish`、`reclaim_base_written`。

## 库用法

```python
from docstore import DocumentStore

store = DocumentStore("/path/to/store", initial={})
store.create_index("byV", "/arr/*/v")
store.apply([{"op": "add", "path": "/arr", "value": [{"v": 1}, {"v": 2}]}])
snap = store.open_snapshot()
store.apply([{"op": "add", "path": "/arr/0", "value": {"v": 0}]}])
store.query([{"index": "byV", "exists": True}], sort_by="byV")
snap.query([{"index": "byV", "eq": 2}])   # 旧版本一致视图
store.reclaim()
```

## CLI

```
python3.11 -m docstore <store-dir>
```

stdin 每行一个 JSON 命令，stdout 每行一个 JSON 结果。命令：`apply`、
`query`、`get`、`create_index`、`drop_index`、`indexes`、`snapshot`、
`release`、`reclaim`、`version`、`doc`。

## 存储布局

```
base.json            reclaim 写入的版本快照
indexes.json         索引定义（名称 -> 模式）
wal/<version>.json   每个已提交批次一条记录（含 sha256 校验）
```

## 测试

```
python3.11 -m unittest discover -s tests -v
```

47 个测试全部通过（结果见 `TEST_RESULTS.txt`），覆盖：数组首部插入多
路径同时迁移、父节点移入自身子树拒绝、同批 test 失败完整回滚、索引
切换并发旧快照查询、三类崩溃恢复注入点，以及与独立全量遍历/参考补丁
解释器（`tests/reference.py`）的随机化交叉核对。
