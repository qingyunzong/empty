# matlib — 运行材料库

仅使用 Go 标准库。

## 设计

- **每次尝试独立目录和版本**：`Begin()` 分配单调递增版本号，材料写入
  `attempts/<version>/` 私有目录；失败重跑拿到全新目录，不会混用旧日志
  （`logs/`）、摘要（`summary.json`）或任何文件。
- **核验后才切换指针**：`Publish()` 先写 `manifest.json`（每个文件的
  SHA-256），再逐项核验目录内容与清单完全一致（无缺失、无多余、哈希
  匹配），全部通过后才切换 `current` 指针。
- **原子切换**：指针通过写临时文件 + `os.Rename` 原子替换；旧尝试目录
  全部保留，可用 `ReadVersion` 单独读取。
- **读者一致性**：`Read()` 只读一次指针，随后从该次尝试目录加载并按
  清单重新核验全部文件；任何损坏导致整体报错，绝不返回部分或跨尝试
  混合的材料。
- **故障注入**：`Hooks` 在发布的四个点注入故障（`BeforeManifestWrite`、
  `BeforeVerify`、`BeforePointerSwitch`、`AfterPointerSwitch`），测试
  逐一核对指针不动、读者仍看到单一完整尝试。

## 测试结果（实际运行）

```
$ go test ./...
ok  	matlib	0.023s
$ go test -race -count=1 ./...
ok  	matlib	1.113s
```

覆盖：重跑不混用、各发布点故障注入、发布前损坏阻断切换、当前材料
损坏时读者报错、旧尝试保留、发布进行中读者只见单一完整尝试、版本
单调唯一、无已发布尝试时返回 `ErrNoCurrent`。
