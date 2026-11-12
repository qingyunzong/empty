# 加权事务的闭合共现集合枚举

包 `dataeng` 为数据画像宿主提供可导入的惰性闭合频繁集合枚举器。

## 输入与语义

- 字典按调用方给定顺序最多 48 个唯一字符串，item 下标就是该顺序。
- 每个事务有唯一 `uint64` ID、正 `uint64` 权重和 item 集合；事务内重复 item 自动按集合处理，空事务合法。
- 未知 item、重复事务 ID、零权重、总权重溢出、非正 `minSupport` 均返回错误。
- `support(X)` 是包含 `X` 的所有事务的权重和。
- `closure(X)` 是包含 `X` 的所有事务的 item 交集；没有事务包含 `X` 时是整个字典。
- 结果恰好是所有 `support(X) >= minSupport` 且 `closure(X) == X` 的集合；空集合本身可以成为结果，空事务库没有结果。

## 使用

```go
import "example.org/dataeng/q0306"

dictionary := []string{"a", "b", "c"}
transactions := []dataeng.Transaction{
	{ID: 1, Weight: 3, Items: []string{"a", "b", "c"}},
	{ID: 2, Weight: 2, Items: []string{"a", "b", "c"}},
	{ID: 3, Weight: 1, Items: []string{"a"}},
}

enumerator, err := dataeng.NewEnumerator(dictionary, transactions, 5)
if err != nil {
	panic(err)
}
defer enumerator.Cancel()

for _, item := range enumerator.Prefix(2) {
	// item.Items 按字典下标升序，item.Support 是权重和。
	_ = item
}
```

`Next()` 一次交付一个结果。不调用 `Next()` 就是暂停；再次调用会从原深度优先栈继续。`Cancel()` 不可逆并释放事务位图，重新枚举必须新建 `Enumerator`。

`Prefix(limit)` 从当前位置最多消费 `limit` 个结果。序列不是普通集合字典序，而是以下固定顺序：

1. 从 `C = closure(空集)` 开始；若频繁先交付 `C`。
2. 按字典下标递增尝试不在 `C` 中的扩展 `i`。
3. 令 `D = closure(C ∪ {i})`；仅当 `D` 频繁且不存在 `j < i`（`j` 在 `D` 而不在 `C`）时进入 `D`。
4. 在 `D` 内只尝试下标大于 `i` 的扩展；闭包新增的 item 不会重复作为当前分支的扩展。

## 计数

`Stats()`、`ExtensionAttempts()`、`CoverIntersections()` 和 `StackDepth()` 暴露实际完成的工作量：真实扩展尝试次数、真实覆盖位图相交次数、当前递归栈深度。没有预求结果或伪造计数。`Cancel()` 后计数仍可读取，栈深度归零。

## 测试

`go test ./...` 包含：

- 12 item 以内的全子集穷举参考，核对完整结果与无重复。
- 独立的直接递归参考，核对逐项交付顺序与实际计数。
- 加权支持、同 support 不同覆盖、共有 item、空事务、高于总权重的阈值、从未出现 item、暂停/取消、48 item 同闭包等夹具。
