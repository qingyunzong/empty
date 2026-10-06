# jsondoc

持久化、多版本的 JSON 文档库，支持通配符路径索引、增量索引维护、
JSON Patch 批量补丁（全有或全无）、只读版本快照与崩溃恢复。
仅依赖 Python 3.11 标准库。

## 数据模型

- 严格 JSON：重复对象键拒绝；`NaN`/`Infinity` 拒绝。
- 数值按词法类型区分：`1` 是整数（`int`），`1.0`/`1e2` 是小数
  （`decimal.Decimal`），二者永不相等；布尔值不混为整数。
- 文档以命名 ID 存放在一个目录（store）中，每次 `put`/`apply`
  产生一个新版本。

## 路径索引

索引模式是 JSON Pointer（RFC 6901），路径段可以是对象键、数组
下标或通配符 `*`（匹配任意键或下标），支持嵌套通配，如
`/items/*/price`、`/*/*/v`。只有标量叶子进入索引。

索引不可变：每次补丁只重提取受影响子树（数组插入导致的下标迁移、
父节点移动、嵌套通配条目都按子树增量更新），未触及的条目在新旧
版本间结构共享，绝不每次全量重建。

查询：

```python
{"where": [{"eq": ["by_price", 10]},      # 等值（走索引）
           {"exists": "/tags/0"}],         # 存在性（可多个，合取）
 "order_by": "by_price"}                    # 按索引值排序
```

## 版本、快照与回收

- `store.snapshot()` 打开只读版本快照并钉住该版本；
  `store.gc()` 只回收未被钉住且非最新的版本，被引用的快照不受影响。
- `create_index()` 在锁外对不可变基版本做全量扫描；构建期间到达的
  新补丁通过操作日志（oplog）补齐，然后对每个版本的索引表做一次
  原子字典替换完成切换，并发旧快照查询不受干扰。

## 持久化与恢复

提交流水线：校验补丁（失败则整体回滚）→ 追加带 CRC 的 WAL 记录
→ 内存应用 + 增量索引 → 写版本文件并原子替换 HEAD → 截断日志 →
回收旧版本。打开时重放已记录未发布的日志、丢弃撕裂的日志尾部。

`Faults` 提供可注入中断点用于恢复测试：`after_log_append`、
`after_index_built`（索引完成但版本未发布）、`after_publish`
（发布后未回收）、`index_build_scan`、`index_build_done`。

## 库用法

```python
from jsondoc import DocumentStore, loads

store = DocumentStore("/path/to/store")
store.put("d1", loads('{"price": 10, "tags": ["a", "b"]}'))
store.create_index("by_price", "/price")
store.apply("d1", [{"op": "add", "path": "/tags/-", "value": "c"}])
store.query({"where": [{"eq": ["by_price", 10]}]})   # -> ["d1"]
with store.snapshot() as snap:
    snap.query({"where": [{"exists": "/tags"}]})
```

## CLI

```
python3.11 -m jsondoc --dir STORE put d1 '{"n": 1}'
python3.11 -m jsondoc --dir STORE index by_n /n
python3.11 -m jsondoc --dir STORE apply d1 '[{"op":"replace","path":"/n","value":2}]'
python3.11 -m jsondoc --dir STORE query '{"where":[{"eq":["by_n",2]}]}'
python3.11 -m jsondoc --dir STORE get d1
python3.11 -m jsondoc --dir STORE versions
python3.11 -m jsondoc --dir STORE gc
```

输入输出均为严格 JSON；错误以 JSON 形式输出到 stderr，退出码为 2。

## 测试

```
python3.11 -m unittest discover -s tests -v
```

`tests/test_crosscheck.py` 用独立的全量遍历与补丁参考解释器
（`tests/reference.py`）对随机小文档核对查询结果、版本号与索引计数。

