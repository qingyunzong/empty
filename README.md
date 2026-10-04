# threepipe

三阶段（可推广为 N 阶段）处理流水线，仅使用 Go 标准库，泛型实现。

## 语义

- **按输入序输出**：每项在 `Submit` 时分配序号，重排 goroutine 严格按序号
  发出结果；各阶段多 worker 并发执行，完成顺序可乱序。
- **暂停只阻止新输入**：`Pause` 阻塞后续 `Submit`（支持 `ctx` 取消），
  已接受项继续流经各阶段排空；`Resume` 唤醒提交者。
- **在途上限**：`New(maxInFlight, workers, stages...)` 以信号量限制
  "已接受但未发出" 的总量；输出无人读取时，发送端持令牌阻塞，
  在途量因此永不越限。
- **失败取消后续项**：首个失败项的序号经 CAS 记录为最小失败序号；
  序号更大的项在各阶段入口被丢弃并释放令牌，已输出前缀完整保留，
  随后发出错误结果并关闭输出通道。此后的 `Submit` 返回 `ErrFailed`。

## 验收（屏障 + 计数器）

- `TestOutputOrderMatchesInput`：小输入刻意慢处理制造乱序完成，断言输出
  序号严格递增。
- `TestPauseBlocksOnlyNewInput`：暂停期间以屏障确认已接受项排空，以计数器
  确认无新提交进入第一阶段。
- `TestBackpressureBoundsInFlight`：不读输出，以计数器断言进入阶段的项数
  不超过上限、超额提交全部阻塞。
- `TestFailureCancelsSuccessorsKeepsPrefix`：单 worker + 屏障使失败时序确定，
  断言前缀完整、错误最后送达、第三关计数器恰好等于前缀长度。
- `TestSubmitAfterCloseAndFailure`：终态后的提交错误码。

## 实测结果

```
$ go test ./...
ok  	threepipe	0.191s
```

`go test -race -count=10 ./...` 亦全部通过（ok，约 2.8s）。
