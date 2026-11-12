# 列式嵌套值重建

采集服务需要可导入的Go列式数据重建组件。输入为重复层级、定义层级对及非空整数值流，均可分块，两个流按调用方顺序分别追加并在显式结束时封口。模式固定为可空列表且元素可空：重复层级0开始新行，定义0表示null列表，1表示空列表，2表示含一个null元素，3表示含一个非空元素；重复层级1只可继续已有非空列表，定义只能为2或3，分别追加null或非空元素。仅定义3消费一个值；等待中的值尚未到达时暂停，值流结束仍缺值、额外值或非法组合均失败。空输入表示零行。完整行写事务暂存，两个流结束并校验通过才提交；提交结果不明返回待确认，不重试。用独立编码器测试跨块长列表、值迟到、非法继续及截断。

## 用法

`dataeng.Rebuilder` 从实现 `dataeng.Sink` 的存储层获取事务，按块追加两个流，
各自显式封口后由组件暂存、校验并提交：

```go
r, err := dataeng.NewRebuilder(sink)
if err != nil { /* Begin 失败 */ }

for chunk := range levelChunks {
    if err := r.AppendLevels(ctx, chunk); err != nil { break }
}
for chunk := range valueChunks {
    if err := r.AppendValues(ctx, chunk); err != nil { break }
}
if err := r.SealLevels(ctx); err != nil { /* 缺值/额外值/非法组合 */ }
if err := r.SealValues(ctx); err != nil { /* 触发提交或失败 */ }

state, err := r.Wait(ctx)
switch state {
case dataeng.StateCommitted:
    // 全部行已提交
case dataeng.StateNeedsConfirmation:
    // Commit 返回 ErrCommitUnknown，事务保留在 Result().Transaction，不重试
case dataeng.StateFailed:
    // 校验或提交失败，事务已回滚，err 可用 errors.Is 匹配哨兵错误
}
```

`Transaction` 由接入方实现：`Stage` 暂存完整行，`Commit`/`Rollback` 控制事务；
提交结果不确定时 `Commit` 返回（或包装）`ErrCommitUnknown`。
