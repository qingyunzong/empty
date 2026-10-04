# ownership

两阶段所有权转移库（仅 Go 标准库）。

## 协议

- **Prepare**：原持有人声明向指定接收者转移的意图（带截止时间）。准备阶段所有权不变，原持有人仍拥有资源。
- **Confirm**：截止时间前确认，在锁内单次赋值完成原子转移，并推进世代号使旧票据失效；超过截止时间的迟到确认返回 `ErrTransferExpired` 被拒绝。
- **Cancel / ExpireTimeouts**：超时撤回，所有权保持原持有人。
- **世代票据**：资源以 `Ticket{Name, Gen}` 标识。名字释放后可复用，新化身获得新世代号，旧票据操作返回 `ErrStaleTicket`，防止名字复用串扰。
- **恰有一所有者**：任意时刻每个已注册资源恰好有一个所有者。Prepare 不产生第二所有者；Confirm 在临界区内单次赋值交换唯一所有者；Cancel/超时不触碰所有者。`TestExactlyOneOwnerUnderInterleaving`（确定性交错）与 `TestConcurrentInterleavingKeepsExactlyOneOwner`（并发压力 + 枚举器持续校验不变量）对此进行证明。

## 测试结果（实际运行记录）

环境：go1.27.1 linux/amd64，2026-10-05。

```
$ go test ./...
ok  	ownership	0.009s
```

另运行 `go test -race -count=1 -v ./...`：9 个测试全部 PASS（含 race 检测），`ok ownership 1.079s`。
