# posidx

位置倒排索引库 + CLI，纯 Python 标准库（3.11+）。

## 语义

- **tokenize**：Unicode 小写后取字母/数字连续段；位置从 0 开始，仅对 token 计数。
- **重复 ingest 同一 id**：整体替换旧版本，旧词不再命中。
- **delete**：删除不存在的 id 为 no-op；已删文档不出现在任何结果中。
- **查询**：`AND` / `OR` / `NOT`（大小写不敏感，优先级 NOT > AND > OR，支持括号），
  `"a b"` 短语要求连续位置。
- **save/load**：`PositionalIndex.save(dir)` / `PositionalIndex.load(dir)`，
  持久化后与内存结果一致；load 时由 token 流重建倒排，保证一致性。

## CLI

    python -m posidx ingest INDEX_DIR docs.jsonl   # 每行 {"id": str, "text": str}
    python -m posidx delete INDEX_DIR ID
    python -m posidx query  INDEX_DIR 'hello AND "new york"'

查询结果以 JSON 数组（排序后的 id）输出到 stdout。

退出码：`0` 成功（无结果输出 `[]`）；`2` JSONL 坏行（跳过并继续）；
`3` 查询语法错误；`4` 索引目录损坏。

## 库用法

    from posidx import PositionalIndex, search

    idx = PositionalIndex()
    idx.ingest("d1", "The quick brown fox")
    idx.delete("d1")
    idx.save("/path/to/index")
    idx2 = PositionalIndex.load("/path/to/index")
    search(idx2, 'quick AND NOT "brown fox"')

## 测试

    python -m unittest discover -s tests -v

真实运行记录见 `RESULTS.md`。
