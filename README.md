# 文件尾随轮转归属

日志源需要可直接接入 Go tail 状态组件，按文件 id、路径、size 和指纹处理 rename-create、copytruncate 与延迟写入旧文件。每条记录绑定文件世代和字节偏移；截断开启新世代，旧句柄可读到 EOF 后关闭。恢复不把新文件偏移套到旧文件。

## 用法

```go
tl := dataeng.NewTailer("/var/log/app.log")
defer tl.Close()

for {
    recs, err := tl.Poll() // 每条 Record 绑定 FileID、Generation、Offset
    // ...
}

// 持久化与恢复
cp, _ := tl.Checkpoint()
dataeng.SaveCheckpoint("checkpoint.json", cp)

cp, _ = dataeng.LoadCheckpoint("checkpoint.json")
tl, _ = dataeng.Restore(cp) // 指纹不匹配时从 0 开始新世代
```

## 语义

- **rename-create**：路径上 FileID 变化时，旧句柄转入排空队列，读到 EOF（含轮转后的延迟写入）后关闭；新文件开启新世代、偏移从 0 开始。
- **copytruncate**：同 inode 的 size 小于已消费偏移时判定为截断，开启新世代并从头读取。
- **延迟写入旧文件**：rename 后路径暂时不存在时保留旧句柄，继续吸收写入方持有的旧 fd 产生的数据，归属旧世代。
- **恢复**：仅当 FileID 与头部指纹（前 min(size, 1024) 字节）都与检查点一致时才沿用偏移与世代，否则从偏移 0 开始，避免把任一文件的偏移套到另一文件上。
