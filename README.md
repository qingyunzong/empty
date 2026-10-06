# graphlib

内存图库：边按 ID 稳定排序的游标分页，游标固定快照版本 + 最后边 ID，
双向边索引原子更新。

## 语义

- **稳定排序**：所有列表（全量 / 出边 / 入边）按边 ID 严格升序。
- **快照游标**：空游标开始分页时固定当前快照版本；`NextCursor` 编码
  `v<version>:<lastID>`。之后的删除、插入不影响该游标的读集（MVCC
  写时复制快照）。
- **过期游标**：快照仅保留最近 `retain` 个版本；引用已淘汰版本的游标
  返回 `ErrCursorExpired`， malformed 游标返回 `ErrInvalidCursor`。
- **原子双向索引**：`AddEdge` / `RemoveEdge` 在单次提交内同时更新边集、
  出边索引、入边索引，读者只见到一致的快照。

## 用法

```go
s := graph.NewStore(64) // 保留最近 64 个版本
e := s.AddEdge("a", "b", "knows")

page, _ := s.ListEdges("", 100)        // 全量分页
out, _ := s.ListOutEdges("a", "", 100) // 出边分页
in, _ := s.ListInEdges("b", "", 100)   // 入边分页
for page.NextCursor != "" {
    page, _ = s.ListEdges(page.NextCursor, 100)
}
_ = s.RemoveEdge(e.ID)
```

## 测试

```sh
go test ./...          # 单元 + 随机分页对照快照全列表
go test ./graph/ -race # 并发读写下双向索引一致性
```
