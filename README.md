# Erasure-coded object storage

`formal` 是一个只依赖标准库的 Go 纠删码库，面向对象存储的写入、降级读与
读写仲裁。条带被拆成 `k` 个数据块和 `m` 个校验块；任意 `k` 个块（数据块或
校验块的任意组合）都能逐字节精确重建原对象。

## 编解码

- 有限域为 GF(2^8)，本原多项式 `x^8 + x^4 + x^3 + x^2 + 1`（`0x11d`），
  本原元为 2。指数/对数表在包初始化时一次构建，编码结果完全确定。
- 校验矩阵使用 Cauchy 构造 `C[i][j] = 1/(i XOR (m+j))`。Cauchy 矩阵的任意
  方子阵非奇异，因此系统矩阵 `[I | C]` 是 MDS：任意 `k` 行可逆。
- `Encode` 要求数据长度是 `k` 的整数倍；`EncodePadded` 会补零，配合
  `ReconstructData(shards, dataLen)` 可还原任意长度的原始字节。
- `Reconstruct` 原地填补 `nil`/空切片表示的缺失块。缺失数不超过 `m` 时必然
  成功。它修复擦除而非静默纠错；可用 `Verify` 检查已有块是否自洽。

```go
codec, err := formal.New(4, 2)
shards, err := codec.EncodePadded(object)

shards[1] = nil // 丢失一个数据块
shards[5] = nil // 丢失一个校验块
data, err := codec.ReconstructData(shards, len(object))
```

## 仲裁与版本

`Cluster` 在 n = k+m 个节点上各存一个分片：

- 写仲裁 `W >= k`：达到 W 个节点确认后才提交版本。
- 读仲裁 `R >= k`：至少收到 R 个响应，并收集到 k 个同一提交版本的分片。
- `W + R > n`：读写仲裁集必然相交，读者能观察到最新已提交版本。

每次写入使用单调递增版本。读请求按提交水位线快照：

1. 所有节点按 `maxVersion = committed` 返回各自最新的、不高于该版本的块。
2. 只接收恰好等于该版本且元数据一致的块；旧版本、晚到的旧响应和未提交版本
   全部忽略。
3. 一旦收到 k 个同版本块就复制成不可变快照并重建，之后到达的块不会再参与
   本次解码，因此不会出现跨版本混合。
4. 若读期间提交水位线前进且当前快照不足 k 块，则用新版本重试。

未达到写仲裁的写入不会推进水位线，因此其残留分片对读者不可见；节点保留旧版本
使得失败写入不会破坏已提交数据。

```go
cluster, err := formal.NewCluster(formal.QuorumConfig{
    DataShards:   4,
    ParityShards: 2,
    WriteQuorum:  4,
    ReadQuorum:   4,
}, nodes)

version, err := cluster.Write(ctx, "photo-42", data)
data, version, err = cluster.ReadVersion(ctx, "photo-42")
```

## 测试

```sh
go test ./...
go test -race ./...
```

测试用小条带穷举所有缺失数不超过 `m` 的组合，逐字节比对原始块，并用独立实现的
逐位有限域乘法和朴素编码核对：

- 完整编码结果（数据块与校验块）与朴素编码一致；
- 重建后的每个块与原始块一致；
- 重建后重新计算的校验方程保持不变（守恒）；
- 编码对 XOR 线性；
- 补零条带只返回原长度字节。

仲裁测试覆盖部分节点失败、降级读、写失败不推进水位线，以及“k 个新版本块先到、
旧版本块晚到”的场景：读取在旧块到达前完成，且结果只属于新版本。若最新已提交
版本不足 k 块，即使旧版本块足够，读取也返回 `ErrUnavailable`，绝不混用版本。

## 边界与限制

- `Reconstruct` 修复擦除，不定位/纠正静默损坏；`Verify` 只能报告不一致。
- `Cluster` 的版本计数器在当前进程内单调递增；跨进程重启需要外部持久化版本或
  元数据服务，避免版本号回绕。
- `MemoryNode` 保留所有版本，便于测试和快照读。生产节点至少要保留并发读者可能
  引用的旧版本；提交后的回收策略由部署方决定。
