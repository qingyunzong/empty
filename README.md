# gallery

版本化图边存储：按边 ID 稳定排序分页，游标固定快照版本，双向边索引原子更新。

## 核心语义

- **稳定排序分页**：所有边按 ID 升序排列，`Page(cursor, limit)` 返回 `ID > cursor.LastID` 的下一页。
- **快照游标**：`Cursor{Version, LastID}` 把分页位置钉在不可变快照版本上；游标创建后的删除、插入不影响旧游标的读集。
- **过期游标**：存储只保留最近 `retain` 个版本，引用已淘汰版本的游标返回 `ErrCursorExpired`（可用 `errors.Is` 判断）。
- **双向边索引**：`AddEdge` / `RemoveEdge` 在同一把写锁内原子更新出索引、入索引和新快照版本；`Neighbors(node, Out|In)` 查询邻接边。

## 示例

```go
s := gallery.NewStore(64) // 保留最近 64 个快照版本
s.AddEdge("a", "b")
s.AddEdge("b", "c")

cursor := s.Begin()        // 钉住当前版本
page, next, err := s.Page(cursor, 1) // 第一页
_ = next                            // 下一页继续用该游标，期间增删不影响读集
_ = page
_ = err
```

## 测试

```sh
go test ./...        # 单元测试 + 随机分页对照快照全列表
go test -race ./...  # 并发读写竞态检测
```
