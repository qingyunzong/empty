# dualidx — 双索引代际检索库

仅使用 Go 标准库。同时维护**内容索引**（词项 → 文档倒排表）与**路径索引**
（路径 ↔ 文档 ID），两者从同一语料快照构建，作为不可变**代（generation）**
一起落盘、一起发布。

## 设计

- `Store.Rebuild(srcDir)`：扫描源目录 → 内存构建双索引 → 依次落盘
  `content.gob`、`path.gob`（写临时文件 + rename）→ 原子替换 `CURRENT`
  指针文件完成发布。任一步失败（含注入故障）即清理新代目录，旧代保持发布。
- `Store.Acquire()` → `View`：读者钉住当前代，引用计数 +1；同一代内
  `Search`/`Lookup`/`/`Paths` 始终来自同一份双索引快照。
- 旧代文件仅在代被替换 **且** 最后一个读者 `Close` 后由 `sweep` 删除。
- `FaultInjector` 提供三个故障注入点：`SetPersistContentFail`、
  `SetPersistPathFail`、`SetPublishFail`，注入错误包装 `ErrInjected`。

## 测试（查询与原始文件扫描对照）

测试用独立的 `rawSearch`/`rawPaths` 直接遍历源文件作为基准，对照索引查询结果：
批量更新前后两代视图各自与对应语料对照；三个故障点分别注入后验证旧代保留、
失败代无残留文件、恢复后正常发布；读者持有期间旧代文件保留、释放后删除；
并发读写（`-race`）下每个视图内部双索引一致。

## 实际运行结果

```
$ go test ./... -race -count=1
ok  	dualidx	1.036s

$ go test ./... -count=1
ok  	dualidx	0.008s
```

7 个测试全部通过（含 3 个故障注入子用例），Go 1.27.1 linux/amd64。
