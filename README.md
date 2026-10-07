# rescheck

资源检查库：跟踪句柄创建、子句柄共享与释放，输出泄漏所有者路径。

## 语义

- `Tracker.Root(name)` 创建根句柄，`Handle.Child(name)` 派生子句柄，构成树状所有权图。
- 父块仅当其自身已释放**且**全部子句柄引用都释放后才被回收，回收沿树向上级联。
- 句柄关闭后不允许再创建子句柄（`ErrClosed`）。
- 句柄以「槽位 + 代际号」标识；槽位复用时代际号递增，旧代际句柄操作返回 `ErrStale`（防 ABA 重用）。
- 重复释放返回 `ErrDoubleRelease`。
- `Tracker.Leaks()` / `Tracker.Close()` 报告泄漏句柄的所有者路径，路径各段带代际号以区分槽位重用，如 `db#1/conn#2`。

## 示例

```go
tr := rescheck.New()
db, _ := tr.Root("db")
conn, _ := db.Child("conn")
db.Release()              // 合法：父块在 conn 释放前不回收
conn.Release()
if err := tr.Close(); err != nil {
    // err 为 *rescheck.LeakError，Paths 为泄漏所有者路径
}
```

## 测试

```sh
go test ./...
```

覆盖：父块回收时机、关闭后派生拒绝、重复释放、代际防重用、泄漏路径输出、
合法随机图模型对照（3000 步随机操作与参考模型逐步比对）、单错注入核验
（重复释放 / 关闭后派生 / 失效句柄 / 遗漏释放，含随机脚本注入）。
