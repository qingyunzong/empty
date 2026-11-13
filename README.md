# MIME 邮箱增量游标

可直接接入的 Go 增量状态组件，协调 UIDVALIDITY、UID、MODSEQ 与
VANISHED。模块路径为 `example.org/dataeng/q0012`，包名为 `dataeng`。

## 核心语义

- UIDVALIDITY 不变时只校验服务端游标没有回退，不用 SELECT 返回的新值覆盖已落库的恢复点，避免重启后跳过待重放的 QRESYNC 窗口。
- UIDVALIDITY 变化时原子关闭旧世代、清空旧消息并开启新世代；旧 Snapshot 和旧 QRESYNC 请求统一返回 `ErrStaleGeneration`。
- 每个响应都必须携带 `Snapshot`。`Snapshot.Revision` 是乐观锁；快照之后发生过任何提交，整个响应返回 `ErrStaleSnapshot`，不会产生部分写入。
- QRESYNC 的 VANISHED 与 FETCH 只在 `QResyncRequest` 绑定的世代和 revision 上生效；冲突、游标回退或过期响应均整体拒绝。
- 消息身份是 `(mailbox, generation, UIDVALIDITY, UID)`，不是 Message-ID。移动或复制会为新的 UID 建立独立记录，Message-ID 只作为元数据保留，并记录 `MovedFrom` 来源。
- 消息变更和恢复点通过唯一写接口 `Store.Commit` 提交。`Commit` 中的每个邮箱变更、删除、Upsert 和恢复点必须全部成功或全部不生效。
- `MailboxChange.Reset` 关闭当前活动世代，不要求归档库删除旧世代历史；但旧世代记录不得再作为新世代成员返回。

原子性同时保证 QRESYNC 的 known-UID 集合可恢复：重启后消息集合与
`UIDNEXT`/`HIGHESTMODSEQ` 来自同一提交，不会出现恢复点已前进、但待处理的
VANISHED/FETCH 消息尚未落库的窗口。

## 接入流程

```go
package main

import (
	"context"
	"fmt"

	"example.org/dataeng/q0012"
)

func main() {
	ctx := context.Background()
	tracker := dataeng.NewTracker(dataeng.NewMemoryStore())

	// SELECT 返回 UIDVALIDITY/UIDNEXT/HIGHESTMODSEQ。
	opened, err := tracker.Open(ctx, dataeng.OpenRequest{
		Mailbox:       "INBOX",
		UIDValidity:   100,
		UIDNext:       2,
		HighestModSeq: 0,
	})
	if err != nil {
		panic(err)
	}
	fmt.Println(opened.ResyncRequired) // 首次打开需要全量同步

	// 后续响应使用快照；失败时整体回滚。
	snapshot, err := tracker.Snapshot(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	err = tracker.ApplyFetch(ctx, snapshot, []dataeng.Message{
		{UID: 1, ModSeq: 10, MessageID: "<one@example.org>", Size: 4096},
	})
	if err != nil {
		panic(err)
	}

	// 重启后从持久化 Store 取回同一个恢复点。
	point, err := tracker.RecoveryPoint(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	fmt.Println(point.UIDValidity, point.UIDNext, point.HighestModSeq)

	// QRESYNC 请求绑定当前 revision；响应过期即拒绝。
	request, err := tracker.BeginQResync(ctx, "INBOX")
	if err != nil {
		panic(err)
	}
	err = tracker.ApplyQResync(ctx, request, dataeng.QResyncResponse{
		Vanished:      []dataeng.UID{1},
		UIDNext:       2,
		HighestModSeq: 20,
	})
	if err != nil {
		panic(err)
	}
}
```

## 自定义 Store

生产环境实现 `Store` 时，`Commit` 必须对应一个数据库事务：

1. 校验每个 `MailboxChange.ExpectedRevision` 等于当前 revision。
2. 在同一事务中写入 Upsert/删除消息，并把 `UIDNext`、`HighestModSeq` 和新 revision 一起写入恢复点。
3. 跨邮箱移动时，`Commit.Mailboxes` 里的源邮箱删除、目标邮箱插入和两边恢复点必须在同一事务提交。
4. 任一校验失败时回滚整个 `Commit`，不能留下已写入的消息或已推进的恢复点。

参考实现 `MemoryStore` 在单把锁内先验证全部变更再统一生效，可用于单测或嵌入式场景。

## IMAP 事件映射

| IMAP 事件 | 调用 |
| --- | --- |
| `SELECT` / `EXAMINE` 返回 UIDVALIDITY | `Open`；`ResyncRequired` 为真时放弃旧世代并全量同步 |
| `SELECT ... QRESYNC` | `BeginQResync` 后调用 `ApplyQResync` |
| `FETCH`（UID/MODSEQ/flags） | `Snapshot` 后调用 `ApplyFetch` |
| `VANISHED` / `VANISHED (EARLIER)` | `ApplyVanished`，或并入 `QResyncResponse` |
| `UID MOVE` / `COPYUID` | `ApplyMove`，源 UID 与目标新 UID 成对传入 |

## 测试

```sh
go test ./...
go test -race ./...
```
