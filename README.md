# backupupload

备份端上传库（仅 Go 标准库）。分片可乱序、可重叠到达；提交先校验再同步，
最后以原子 rename 发布，读者始终看到完整的旧版或新版。

## 设计

- `Store.Begin(name)` 开启上传会话，分片写入同目录的 `<name>.staging` 暂存文件。
- `Session.WriteChunk(off, data)` 乱序写入；与已写区域重叠时逐字节比对，
  不一致返回 `ErrOverlapConflict` 且不写入任何字节。
- `Session.Commit(size, sha256)` 按序执行：
  1. 校验分片完整覆盖 `[0, size)`（否则 `ErrIncomplete`）；
  2. 校验暂存内容 SHA-256（否则 `ErrHashMismatch`）；
  3. `fsync` 暂存文件；
  4. 原子 `rename` 发布，随后 `fsync` 目录。
  任一步失败，已发布的旧版本不受影响。
- `Store.Recover()` 删除遗留暂存文件。由于发布是单个原子 rename，
  恢复后对象只能是完整旧版或完整新版。
- `Store.Faults` 注入 write / sync / rename 三类故障，用于崩溃演练。

## 测试结果

`go test ./...`（go1.27.1 linux/amd64，另以 `-race` 复跑通过）：

```
ok  	backupupload	0.013s
```

- TestOutOfOrderChunks — 乱序分片正确组装
- TestOverlapConsistency — 重叠一致接受 / 冲突拒绝
- TestCommitIncompleteKeepsOldVersion — 覆盖不全拒绝提交，旧版可读
- TestCommitHashMismatchKeepsOldVersion — 哈希不符拒绝提交，旧版可读
- TestCrashAtEveryPointRecoversToOldOrNew — 在每个故障点崩溃，恢复后仅为完整旧版或新版
- TestInjectedFailuresKeepOldVersion — write/sync/rename 注入失败均不损旧版
- TestOldReaderKeepsReadingAfterCommit — 已打开旧版的读者继续读旧版
- TestConcurrentReadersSeeComplete-/TestRecoverKeepsPublishedObject — 并发读者只见完整版本；恢复不误删已发布对象
