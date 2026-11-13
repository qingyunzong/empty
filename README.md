# 监视流的书签与过期

集群采集调用可导入的Go包跟随监视事件，不建立监视。事件类型为ADDED、MODIFIED、DELETED、BOOKMARK、ERROR。书签只推进资源版本，不产出对象。过期错误返回必须重列，不清空已有缓存；其他错误停止。资源版本由调用方的比较函数判定，不能后退。相等的书签忽略，相等的对象事件仍要交付。删除未知键要报告。用版本序列核对书签、过期和回退，期望不得由被测包生成。

## 使用方式

```go
compare := func(a, b string) int { /* 返回负数表示 a 更旧，0 表示相等 */ }
follower := dataeng.NewFollower(compare)

changes, err := follower.Apply(event)
switch {
case errors.Is(err, dataeng.ErrExpired):
	// 调用方重新 list，再把完整列表交给 follower.Relist。
case err != nil:
	// 其他错误停止跟随。
}
```

`Apply` 返回本次接受对象事件产生的 `Change`；书签只推进
`ResourceVersion()`，`Snapshot()` 可读取当前缓存。过期错误不会清空缓存，
过期后的重列由调用方发起。
