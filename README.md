# docret — 多字段位置索引文档检索

纯 Python 3.11 标准库实现的多字段文档检索库，带 JSON CLI。

## 特性

- **位置索引**：每个词元记录字段路径、字段实例序号、段落号和原文字符跨度；
  每次命中都返回可定位到原文的字段与跨度证据。
- **字段继承与数组**：JSON 文档扁平化为字段实例；数组的每个元素是同名字段的
  独立实例，词元绝不跨实例混合，因此不会组成不存在的"伪短语"。
- **查询语言**：字段限定（`title:foo`、`meta.*:"a b"`、`f:(a OR b)`）、短语
  （`"quick brown"`）、`AND` / `OR` / `NOT`、邻近（`a NEAR/2 b`）与嵌套括号。
  优先级：`NOT` > `NEAR/n` > `AND` > `OR`。
- **NOT 语义**：`NOT q` 是对被查询索引（或快照）**文档全集**的补集——包含
  字段为空或缺失的文档。`a AND NOT b` 即 a 的结果减去 b 的结果。
- **两类结果不混淆**：位置结果（`PosResult`，doc → 证据列表）与布尔结果
  （`DocSetResult`，纯 doc 集合）是两种类型。`AND`/`OR` 两边都是位置结果时
  保持位置性；任一侧为布尔时显式降级为布尔集合。`NOT` 恒为布尔。短语与
  `NEAR` 要求位置操作数，传入布尔表达式会在编译期报 `QueryError`。
- **字段通配**：`*` 匹配一段路径，末尾的 `*` 匹配一段或多段。通配命中多个
  字段时，每个短语必须在**同一个合法字段实例**内完成。
- **批量修改**：`apply_batch` 原子地应用 `add_doc` / `remove_doc` / `set` /
  `delete` / `move`（嵌套字段移动）；任一操作失败整批回滚，索引与统计在一次
  状态交换中原子更新。
- **字段别名**：`set_alias(name, spec)` 支持链式与通配目标；形成环时报
  `AliasError` 且规则不生效。
- **快照查询**：`snapshot()` 固定某一时刻的索引状态与别名规则，之后的提交
  不影响快照查询。
- **候选缓存**：查询结果按 `(索引版本, 别名规则版本, 查询串)` 缓存；任何
  提交或别名规则变更都会使其失效。
- **独立解释器**：`docret.interpreter` 不经过倒排索引、逐文档直接求值，用于
  在小语料上核对索引数据流的全部查询结果。

## 库用法

```python
from docret import Index

idx = Index()
idx.apply_batch([
    {"op": "add_doc", "doc": "d1", "document": {
        "title": "the quick brown fox",
        "tags": ["red fox", "blue whale"],
    }},
])
idx.set_alias("headline", "title")
res = idx.query('headline:"quick brown" AND NOT tags:whale')
for doc in res.docs:
    for ev in res.evidence.get(doc, []):
        print(doc, ev.field_path, ev.char_start, ev.char_end, ev.text)
```

## CLI

```bash
# 文档文件为 JSONL：{"id": "d1", "doc": {...}}
python3.11 -m docret build docs.jsonl index.json
python3.11 -m docret query index.json 'title:"quick brown" AND NOT tags:whale'
python3.11 -m docret check index.json 'quick NEAR/2 fox'   # 索引 vs 解释器核对
python3.11 -m docret alias index.json --set headline=title
python3.11 -m docret batch index.json ops.json             # ops 为 JSON 操作列表
python3.11 -m docret stats index.json
```

所有命令输出 JSON；查询输出每个命中的字段、实例、段落、词元区间、字符跨度
与原文片段。

## 测试

```bash
python3.11 -m unittest discover -s tests -v
```

覆盖：同名数组字段、跨字段伪短语、NOT 与空字段、别名成环、同文档多个片段、
嵌套字段移动、失败批次回滚、保存恢复，以及索引数据流与独立解释器的全查询
交叉核对。
