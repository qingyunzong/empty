# IMAP UIDVALIDITY 邮件增量归档

邮件归档服务需要可导入的 Go IMAP 增量状态库，联合 UIDVALIDITY、UID、MODSEQ、EXPUNGE 与正文摘要维护邮箱快照。UIDVALIDITY 变化触发新世代重扫，不能沿用旧 UID 游标；QRESYNC 乱序事件经重放后与完整列表一致，并保留删除证据。

## 模块

Go module `example.org/dataeng/q0213`，包 `dataeng`，仅依赖标准库。

```go
import "example.org/dataeng/q0213"
```

## 核心模型

- `State`：线程安全的邮箱状态，按邮箱名隔离，内部为 `RWMutex` 保护的快照。
- `Generation`：UIDVALIDITY 世代。UIDVALIDITY 一旦变化就开启全新空世代，
  `Selection.FullRescan` 为 `true`，旧 UID/MODSEQ 游标不会被复用；历史世代
  （消息与墓碑）完整保留用于审计。
- `Message`：联合 UID、MODSEQ、标志位与正文 `Digest`（SHA-256 + 字节数）。
- `Tombstone`：删除证据。EXPUNGE、QRESYNC VANISHED 与全量对账缺失的 UID 都会
  留下墓碑；即便正文从未抓取到也会记录 UID、原因与时间，抓取过的还保留最后摘要。

## 同步流程

1. `Select(mailbox, uidValidity)` 获取同步位置。首扫或 UIDVALIDITY 变化时
   `FullRescan=true`，必须拉取完整 UID 列表并调用 `Reconcile`。
2. 增量阶段把 CONDSTORE/QRESYNC 事件交给 `Replay`。事件先按 MODSEQ 稳定排序
   （无 MODSEQ 的事件保持输入顺序并排在最前），再统一应用，因此乱序批次重放后
   与全量列表收敛到同一快照；晚到的 FETCH 会复活墓碑 UID，晚到的删除会重新落碑。
3. 离散事件也可直接用 `ApplyFetch` / `ApplyExpunge` / `ApplyVanished`。
   注意 IMAP EXPUNGE 响应只带序列号，调用方需先完成序列号到 UID 的映射。
4. `SyncCursor` 与抓取/删除事件共同维护单调不减的 `UIDNext`、`HighestModSeq`。

```go
state := dataeng.New()
sel, err := state.Select("INBOX", uidValidity)
if err != nil { /* ... */ }

if sel.FullRescan {
    digest, _ := dataeng.SHA256Digest(bodyReader)
    _, err = state.Reconcile("INBOX", []dataeng.Message{
        {UID: uid, ModSeq: modseq, Digest: digest, Flags: flags},
    })
} else {
    _, err = state.Replay("INBOX", []dataeng.Event{
        {Kind: dataeng.EventVanished, UID: uid, ModSeq: modseq, Earlier: true},
    })
}

store := dataeng.NewFileStore("var/imap-state.json")
if err := state.Save(context.Background(), store); err != nil { /* ... */ }
```

## 持久化

- `FileStore`：JSON 快照，先写同目录临时文件再 `rename`，保证原子替换；
  加载时校验格式版本与结构，损坏快照返回错误且不污染当前状态。
- `MemoryStore`：内存快照，便于测试或嵌入其他持久化机制。
- `State.Load` 在尚无快照时返回 `(false, nil)`，错误哨兵为 `ErrNoSnapshot`。

## 测试

```sh
go test ./... -race -count=1
go vet ./...
```

测试覆盖世代切换与游标重置、乱序 QRESYNC 收敛性、删除证据保留、正文摘要、
全量对账、JSON/内存持久化往返、并发访问与参数校验。
