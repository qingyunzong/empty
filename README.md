# backupstore

备份端上传库（仅 Go 标准库）。接收乱序片段与提交请求，保证：

- **乱序片段**：`WriteFragment(off, data)` 可按任意顺序写入，提交时校验完整覆盖 `[0, size)`。
- **重叠一致**：片段可重叠，重叠字节必须与已写入内容完全一致，否则返回 `ErrConflict` 并拒绝该片段。
- **原子提交**：`Commit` 先校验覆盖、fsync 暂存文件，再通过原子 rename 发布，最后 fsync 目录。提交可安全重试，已完成步骤不会重复。
- **旧读者可读**：提交前已打开旧版本的读者继续读旧内容（rename 替换路径，旧 fd 仍指向旧 inode）；新读者看到新版本。
- **崩溃恢复**：`Open` 重新打开存储目录时清理所有未提交的暂存文件，恢复结果只能是完整旧版或完整新版。

## 布局

```
<dir>/objects/<key>     已提交版本
<dir>/staging/<key>.tmp 上传中暂存（提交时 rename 到 objects）
```

## 故障注入

`FaultFS` 包装 `FS`，在每次 write / sync / rename / syncdir 前调用钩子，
返回非 nil 错误即在操作发生前注入失败，用于测试崩溃恢复。

## 测试结果

实际运行（go1.27.1 linux/amd64）：

```
$ go test -race -count=1 ./...
ok  	backupstore	1.026s
$ go test -count=1 ./...
ok  	backupstore	0.006s
```

覆盖用例：

- `TestOutOfOrderFragments`：乱序片段正确组装
- `TestOverlapConsistent` / `TestOverlapConflict`：重叠一致接受 / 冲突拒绝
- `TestCommitWithGapKeepsOldVersion`：缺口提交失败，旧版本保留
- `TestOldReaderRemainsReadable`：旧读者读旧版，新读者读新版
- `TestRetryCommitAfterFault`：注入 write/sync/rename/syncdir 单次失败后重试提交成功
- `TestCrashRecoverySweep`：对第 N 个变更操作逐一注入崩溃并恢复，N=1..7，
  每次恢复结果均为完整旧版或完整新版，暂存目录清空
- `TestGetNotFoundAndInvalidKey` / `TestAbortDiscardsUpload` / `TestZeroLengthUpload` / `ExampleStore`
